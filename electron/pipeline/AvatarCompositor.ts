/**
 * AvatarCompositor — overlays per-segment talking-avatar clips onto an
 * already-rendered commentary video using a single FFmpeg pass.
 *
 * ADDITIVE & SAFE: it writes to a temp file and only renames over the original
 * on success, so any failure leaves the rendered commentary video untouched.
 * Processor.ts is intentionally not modified; this runs as a post step.
 */
import fs from 'fs';
import { spawn } from 'child_process';
import type { AvatarOverlay } from '../../shared/avatarTypes';

// Prefer a bundled ffmpeg if available; otherwise fall back to PATH.
let ffmpegPath = 'ffmpeg';
try {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const stat = require('ffmpeg-static');
	if (stat && typeof stat === 'string') ffmpegPath = stat;
} catch {
	/* use PATH ffmpeg */
}

export interface AvatarSegment {
	clipPath: string;
	startSec: number;
	endSec: number;
}

export interface AvatarCompositeArgs {
	inputVideoPath: string;
	avatar: AvatarOverlay;
	segments: AvatarSegment[];
	/** Canvas width used to size the avatar (default 1080). */
	canvasW?: number;
}

export class AvatarCompositor {
	async composite(args: AvatarCompositeArgs): Promise<void> {
		const { inputVideoPath, avatar } = args;
		const canvasW = args.canvasW ?? 1080;
		const segments = (args.segments || []).filter(
			(s) => s.clipPath && fs.existsSync(s.clipPath) && s.endSec > s.startSec,
		);
		if (segments.length === 0) return;

		const avatarW = Math.max(2, Math.round(canvasW * avatar.scale));
		const r = Math.round(avatarW / 2);
		const rr = r * r;

		// Build inputs: main video first, then each avatar clip time-shifted so it
		// starts at its segment boundary on the main timeline.
		const inputs: string[] = ['-i', inputVideoPath];
		segments.forEach((seg) => {
			inputs.push('-itsoffset', seg.startSec.toFixed(3), '-i', seg.clipPath);
		});

		const filters: string[] = [];
		let last = '[0:v]';
		segments.forEach((seg, i) => {
			const idx = i + 1; // ffmpeg input index (0 is the main video)
			const av = `av${i}`;
			// HOLD LAST FRAME: an avatar clip is often a touch shorter than its
			// segment window (talk clip ~= TTS duration, but the segment gets a
			// little padding + xfade overlap). Without padding, the overlay simply
			// vanishes as soon as the clip ends, which looks like an amateur cut.
			// tpad clones the final frame so the avatar stays on-screen through the
			// whole segment; the `enable` gate below still removes it exactly at the
			// segment boundary. The clone is bounded by the main video length.
			const hold = 'tpad=stop_mode=clone:stop_duration=3600,';
			if (avatar.shape === 'circle') {
				filters.push(
					`[${idx}:v]${hold}scale=${avatarW}:${avatarW}:force_original_aspect_ratio=increase,` +
						`crop=${avatarW}:${avatarW},format=rgba,` +
						`geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':` +
						`a='if(gt((X-${r})*(X-${r})+(Y-${r})*(Y-${r})\\,${rr})\\,0\\,255)'[${av}]`,
				);
			} else {
				filters.push(`[${idx}:v]${hold}scale=${avatarW}:-1[${av}]`);
			}
			const pos = this.position(avatar);
			const out = i === segments.length - 1 ? '[vout]' : `[v${i}]`;
			filters.push(
				`${last}[${av}]overlay=${pos.x}:${pos.y}:` +
					`enable='between(t\\,${seg.startSec.toFixed(3)}\\,${seg.endSec.toFixed(3)})'${out}`,
			);
			last = `[v${i}]`;
		});

		const tmpOut = inputVideoPath.replace(/\.mp4$/i, '') + '.avatar.tmp.mp4';
		const ffArgs = [
			'-y',
			...inputs,
			'-filter_complex',
			filters.join(';'),
			'-map',
			'[vout]',
			'-map',
			'0:a?',
			'-c:v',
			'libx264',
			'-crf',
			'18',
			'-preset',
			'veryfast',
			'-pix_fmt',
			'yuv420p',
			'-movflags',
			'+faststart',
			'-c:a',
			'copy',
			tmpOut,
		];

		await this.run(ffArgs);
		await this.finalizeReplace(tmpOut, inputVideoPath);
	}

	/**
	 * Replace the original output with the freshly composited temp file.
	 *
	 * On Windows the just-rendered output is frequently still locked for a
	 * moment (antivirus scanning the new mp4, a lingering ffmpeg handle, or an
	 * open preview player), so a direct rename throws EPERM/EBUSY and the avatar
	 * overlay would be dropped even though every segment rendered fine. Retry
	 * with backoff, then fall back to copying over the destination once the
	 * lock clears.
	 */
	private async finalizeReplace(tmpOut: string, target: string): Promise<void> {
		const isLockErr = (e: any) =>
			!!e &&
			(e.code === 'EPERM' ||
				e.code === 'EBUSY' ||
				e.code === 'EACCES' ||
				e.code === 'ENOTEMPTY');
		const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
		let lastErr: unknown;

		// 1) Try an atomic rename, retrying while the destination is locked.
		for (let attempt = 0; attempt < 15; attempt++) {
			try {
				fs.renameSync(tmpOut, target);
				return;
			} catch (e) {
				lastErr = e;
				if (!isLockErr(e)) throw e;
				await sleep(600);
			}
		}

		// 2) Rename kept failing (destination still locked): copy over it instead,
		//    which succeeds as soon as the reader releases its handle.
		for (let attempt = 0; attempt < 10; attempt++) {
			try {
				fs.copyFileSync(tmpOut, target);
				try {
					fs.unlinkSync(tmpOut);
				} catch {
					/* leave the temp file for manual cleanup */
				}
				return;
			} catch (e) {
				lastErr = e;
				if (!isLockErr(e)) throw e;
				await sleep(600);
			}
		}

		throw lastErr instanceof Error
			? lastErr
			: new Error('failed to replace output with avatar composite (file locked)');
	}

	/** Overlay position expressions using FFmpeg main (W/H) and overlay (w/h) vars. */
	private position(a: AvatarOverlay): { x: string; y: string } {
		const m = a.margin ?? 48;
		if (typeof a.x === 'number' && typeof a.y === 'number') {
			return { x: `${a.x}`, y: `${a.y}` };
		}
		switch (a.position) {
			case 'top-left':
				return { x: `${m}`, y: `${m}` };
			case 'top-right':
				return { x: `W-w-${m}`, y: `${m}` };
			case 'bottom-left':
				return { x: `${m}`, y: `H-h-${m}` };
			case 'bottom-right':
				return { x: `W-w-${m}`, y: `H-h-${m}` };
			case 'center':
				return { x: `(W-w)/2`, y: `(H-h)/2` };
			default:
				return { x: `W-w-${m}`, y: `${m}` };
		}
	}

	private run(ffArgs: string[]): Promise<void> {
		return new Promise((resolve, reject) => {
			const proc = spawn(ffmpegPath, ffArgs, {
				stdio: ['ignore', 'ignore', 'pipe'],
			});
			let err = '';
			proc.stderr?.on('data', (d) => {
				err += d.toString();
			});
			proc.on('error', reject);
			proc.on('close', (code) => {
				if (code === 0) resolve();
				else reject(new Error(`ffmpeg avatar composite failed (${code}): ${err.slice(-2000)}`));
			});
		});
	}
}
