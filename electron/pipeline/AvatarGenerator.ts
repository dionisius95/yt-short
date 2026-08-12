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
}

// Avatar rendering on a Colab T4 can take minutes, so use a generous timeout
// rather than the ~120s used for TTS calls.
const AVATAR_TIMEOUT_MS = 8 * 60 * 1000;
const MAX_ATTEMPTS = 2;

/**
 * Client for the Colab `/avatar` endpoint (hosted on the SAME server as the
 * VoxCPM/XTTS voice clone). This module is ADDITIVE: callers must guard on
 * `avatar.enabled` and treat any thrown error as "skip avatar, render normally".
 */
export class AvatarGenerator {
	async generate(params: AvatarGenerateParams): Promise<string> {
		const { imagePath, audioPath, mode, outputPath } = params;
		const fps = params.fps ?? 25;
		const duration = params.durationSec ?? 4;

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
		});

		let lastErr: unknown;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), AVATAR_TIMEOUT_MS);
			try {
				const res = await fetch(endpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body,
					signal: controller.signal,
				});
				if (!res.ok) {
					const text = await res.text().catch(() => '');
					throw new Error(
						`avatar endpoint HTTP ${res.status}: ${text.slice(0, 500)}`,
					);
				}
				const buf = Buffer.from(await res.arrayBuffer());
				if (!AvatarGenerator.isMp4(buf)) {
					throw new Error('avatar endpoint did not return a valid mp4');
				}
				fs.writeFileSync(outputPath, buf);
				return outputPath;
			} catch (err) {
				lastErr = err;
				if (attempt < MAX_ATTEMPTS) continue;
			} finally {
				clearTimeout(timer);
			}
		}
		throw lastErr instanceof Error
			? lastErr
			: new Error(`avatar generation failed: ${String(lastErr)}`);
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

	/** mp4 streams carry an 'ftyp' box at bytes 4-8. */
	private static isMp4(buf: Buffer): boolean {
		if (!buf || buf.length < 12) return false;
		return buf.toString('ascii', 4, 8) === 'ftyp';
	}
}
