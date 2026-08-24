import * as fs from 'fs';
import type { AvatarOverlay } from '../../shared/avatarTypes';

export interface AvatarGenerateParams {
	/** Absolute path to the avatar source image. */
	imagePath: string;
	/** Cloned-voice wav for 'talk'; null for 'idle'. */
	audioPath: string | null;
	/** 'talk' = lip-sync (Segment A/C), 'idle' = silent blinking (Segment B). */
	mode: 'talk' | 'idle';
	/** Base host URL (same host as VoxCPM/XTTS). '/avatar' is appended. */
	baseUrl: string;
	/** Where to write the resulting mp4. */
	outputPath: string;
	/** Idle clip length in seconds (defaults to 4). */
	durationSec?: number;
	/** Output fps (defaults to 25). */
	fps?: number;
	/**
	 * When true, ask the engine to matte the photo background away so only the
	 * person remains (returns a VP9/alpha .webm). Additive: default false keeps
	 * the opaque mp4 and current behavior.
	 */
	removeBackground?: boolean;
}

// Overall budget for one segment, including the background render + polling.
// Cloudflare quick tunnels drop any SINGLE request past ~100s (HTTP 524), so we
// never hold one request open that long: submit returns instantly with a job id
// and we poll a fast result endpoint until the mp4 is ready.
const AVATAR_TIMEOUT_MS = 45 * 60 * 1000;
// Gap between result polls.
const POLL_INTERVAL_MS = 4000;
// Cap each individual HTTP call so it never sits open near the tunnel's ~100s limit.
const REQUEST_TIMEOUT_MS = 90 * 1000;
// Quick tunnels are flaky: a single dropped connection ('fetch failed') or a
// transient gateway error (HTTP 502/503/504 HTML page) must not abort a
// multi-minute render whose background job is still running. Retry submit a few
// times, and treat transient poll failures as 'still pending'.
const SUBMIT_RETRIES = 5;
const SUBMIT_RETRY_DELAY_MS = 3000;

type SubmitResult = { mp4?: Buffer; jobId?: string; raw?: string };
type PollResult = { pending?: boolean; mp4?: Buffer; error?: string };

/**
 * Client for the Colab `/avatar` endpoint (hosted on the SAME server as the
 * VoxCPM/XTTS voice clone). This module is ADDITIVE: callers must guard on
 * `avatar.enabled` and treat any thrown error as "skip avatar, render normally".
 *
 * Transport is async: POST /avatar enqueues a render and returns { job_id };
 * GET /avatar/result/<job_id> returns 202 while working, then the video. This
 * keeps every request short so Cloudflare quick tunnels never 524 mid-render.
 * Transient connection drops and gateway (502/503/504) hiccups are retried
 * instead of being treated as failures.
 *
 * The finished clip is normally an mp4, but when background removal is enabled
 * the engine returns a VP9/alpha .webm instead; both containers are accepted
 * and written verbatim to outputPath (ffmpeg reads by content, not extension).
 */
export class AvatarGenerator {
	async generate(params: AvatarGenerateParams): Promise<string> {
		const { imagePath, audioPath, mode, outputPath } = params;
		const fps = params.fps ?? 25;
		const duration = params.durationSec ?? 4;
		const removeBackground = params.removeBackground ?? false;

		const imageB64 = fs.readFileSync(imagePath).toString('base64');
		const audioB64 =
			mode === 'talk' && audioPath
				? fs.readFileSync(audioPath).toString('base64')
				: null;

		const base = AvatarGenerator.normalizeBaseHostUrl(params.baseUrl);
		if (!base) throw new Error('AvatarGenerator: empty base URL');
		const endpoint = `${base}/avatar`;
		const body = JSON.stringify({
			image_b64: imageB64,
			audio_b64: audioB64,
			mode,
			duration,
			fps,
			remove_bg: removeBackground,
		});

		const deadline = Date.now() + AVATAR_TIMEOUT_MS;

		// 1) Submit the render job. The server returns a job id right away so the
		//    tunnel never holds a single request open past its ~100s cap.
		const submit = await this.submitJob(endpoint, body, deadline);
		if (submit.mp4) {
			// Backward-compat: an older server streamed the clip straight back.
			fs.writeFileSync(outputPath, new Uint8Array(submit.mp4));
			return outputPath;
		}
		if (!submit.jobId) {
			throw new Error(
				`avatar submit did not return a job_id: ${(submit.raw ?? '').slice(0, 300)}`,
			);
		}

		// 2) Poll for the finished clip until done / error / deadline. Transient
		//    tunnel drops and gateway hiccups are swallowed by pollResult and
		//    retried on the next tick; the background job keeps running.
		const resultUrl = `${base}/avatar/result/${submit.jobId}`;
		while (Date.now() < deadline) {
			await AvatarGenerator.sleep(POLL_INTERVAL_MS);
			const poll = await this.pollResult(resultUrl, deadline);
			if (poll.pending) continue;
			if (poll.mp4) {
				fs.writeFileSync(outputPath, new Uint8Array(poll.mp4));
				return outputPath;
			}
			throw new Error(poll.error || 'avatar generation failed');
		}
		throw new Error('avatar generation timed out while polling for result');
	}

	private async submitJob(
		endpoint: string,
		body: string,
		deadline: number,
	): Promise<SubmitResult> {
		let lastErr: unknown;
		for (let attempt = 0; attempt < SUBMIT_RETRIES; attempt++) {
			if (Date.now() >= deadline) break;
			try {
				const res = await this.fetchWithTimeout(
					endpoint,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body,
					},
					deadline,
				);

				// New async server: 202 + { job_id }.
				if (res.status === 202) {
					const text = await res.text().catch(() => '');
					return { jobId: AvatarGenerator.parseJobId(text), raw: text };
				}

				if (res.ok) {
					const buf = Buffer.from(await res.arrayBuffer());
					if (AvatarGenerator.isVideo(buf)) return { mp4: buf };
					const text = buf.toString('utf-8');
					const jobId = AvatarGenerator.parseJobId(text);
					if (jobId) return { jobId, raw: text };
					throw new Error(
						`avatar submit returned unexpected body: ${text.slice(0, 300)}`,
					);
				}

				// Non-OK: a tunnel gateway hiccup is transient (retry); our own JSON
				// error means the request was truly rejected (surface it).
				const text = await res.text().catch(() => '');
				const msg = AvatarGenerator.fmtHttp('avatar endpoint', res.status, text);
				if (AvatarGenerator.isGatewayError(res.status, text)) {
					lastErr = new Error(msg);
				} else {
					throw new Error(msg);
				}
			} catch (e) {
				lastErr = e;
				if (!AvatarGenerator.isTransient(e)) throw e;
			}
			if (attempt < SUBMIT_RETRIES - 1) {
				await AvatarGenerator.sleep(SUBMIT_RETRY_DELAY_MS);
			}
		}
		throw lastErr instanceof Error ? lastErr : new Error('avatar submit failed');
	}

	private async pollResult(url: string, deadline: number): Promise<PollResult> {
		try {
			const res = await this.fetchWithTimeout(url, { method: 'GET' }, deadline);
			if (res.status === 202) return { pending: true };
			if (res.ok) {
				const buf = Buffer.from(await res.arrayBuffer());
				if (AvatarGenerator.isVideo(buf)) return { mp4: buf };
				// A 200 that is not a full video means the body dropped mid-transfer;
				// the job is still done, so retry on the next tick.
				return { pending: true };
			}
			// Tunnel gateway hiccup (HTML 502/503/504): the render keeps running and
			// the result stays available, so keep polling instead of failing.
			const text = await res.text().catch(() => '');
			if (AvatarGenerator.isGatewayError(res.status, text)) return { pending: true };
			// Our server's own JSON error (e.g. render/OOM failure): stop and report.
			return { error: AvatarGenerator.fmtHttp('avatar result', res.status, text) };
		} catch (e) {
			// Transient tunnel/connection drop during a long render: keep polling.
			if (AvatarGenerator.isTransient(e)) return { pending: true };
			return { error: e instanceof Error ? e.message : String(e) };
		}
	}

	private async fetchWithTimeout(
		url: string,
		init: any,
		deadline: number,
	): Promise<any> {
		const remaining = deadline - Date.now();
		const timeout = Math.max(1000, Math.min(REQUEST_TIMEOUT_MS, remaining));
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);
		try {
			return await fetch(url, { ...init, signal: controller.signal });
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Classify an error as a transient connection failure worth retrying
	 * (tunnel dropped a socket, reset, DNS blip, per-request abort) vs a real
	 * server error that should stop the flow.
	 */
	private static isTransient(e: unknown): boolean {
		const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
		return (
			msg.includes('fetch failed') ||
			msg.includes('aborted') ||
			msg.includes('timeout') ||
			msg.includes('timed out') ||
			msg.includes('econnreset') ||
			msg.includes('econnrefused') ||
			msg.includes('enotfound') ||
			msg.includes('eai_again') ||
			msg.includes('socket') ||
			msg.includes('network') ||
			msg.includes('terminated') ||
			msg.includes('other side closed') ||
			msg.includes('und_err')
		);
	}

	/**
	 * A tunnel/CDN gateway error (not our API). Cloudflare returns 502/503/504
	 * (and 520-527) with an HTML error page when it briefly can't reach the
	 * Colab origin. Our own server always replies with JSON, so an HTML body is
	 * a reliable tell that the error came from the tunnel, not the render.
	 */
	private static isGatewayError(status: number, body: string): boolean {
		if (status === 502 || status === 503 || status === 504 || status === 429) {
			return true;
		}
		if (status >= 520 && status <= 527) return true;
		const b = (body || '').trimStart().toLowerCase();
		return b.startsWith('<!doctype') || b.startsWith('<html');
	}

	/**
	 * Choose avatar.colabUrl when provided, otherwise fall back to the shared
	 * voice-clone URL (xttsColabUrl). Returns '' when neither is set.
	 */
	static resolveBaseUrl(
		avatar: Pick<AvatarOverlay, 'colabUrl'>,
		fallbackUrl?: string,
	): string {
		const chosen = (avatar.colabUrl || fallbackUrl || '').trim();
		return chosen ? AvatarGenerator.normalizeBaseHostUrl(chosen) : '';
	}

	/** Trim trailing slashes and any known route suffix so `${base}/avatar` is clean. */
	private static normalizeBaseHostUrl(url: string): string {
		let u = (url || '').trim().replace(/\/+$/, '');
		u = u.replace(/\/(avatar|clone|tts|synthesize)$/i, '');
		return u;
	}

	private static parseJobId(text: string): string | undefined {
		try {
			const j = JSON.parse(text);
			const id = j?.job_id ?? j?.jobId;
			return typeof id === 'string' && id ? id : undefined;
		} catch {
			return undefined;
		}
	}

	private static fmtHttp(label: string, status: number, text: string): string {
		const msg = `${label} HTTP ${status}`;
		try {
			const j = JSON.parse(text);
			if (j?.error) return `${msg}: ${j.error}`;
		} catch {
			// body was not JSON (e.g. HTML gateway page)
		}
		return text ? `${msg}: ${text.slice(0, 200)}` : msg;
	}

	private static sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/** mp4 streams carry an 'ftyp' box at bytes 4-8. */
	private static isMp4(buf: Buffer): boolean {
		if (!buf || buf.length < 12) return false;
		return buf.toString('ascii', 4, 8) === 'ftyp';
	}

	/** WebM/Matroska streams start with the EBML magic 0x1A45DFA3. */
	private static isWebm(buf: Buffer): boolean {
		if (!buf || buf.length < 4) return false;
		return (
			buf[0] === 0x1a &&
			buf[1] === 0x45 &&
			buf[2] === 0xdf &&
			buf[3] === 0xa3
		);
	}

	/** Accept either an mp4 (opaque) or a webm (alpha, background removed). */
	private static isVideo(buf: Buffer): boolean {
		return AvatarGenerator.isMp4(buf) || AvatarGenerator.isWebm(buf);
	}
}
