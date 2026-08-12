// Talking-avatar overlay types (ADDITIVE).
// Kept in a separate file so the existing pipeline is untouched. When
// `enabled` is false the app must behave exactly like before this feature.

export type AvatarPosition =
	| 'top-left'
	| 'top-right'
	| 'bottom-left'
	| 'bottom-right'
	| 'center';

export type AvatarShape = 'rect' | 'circle';

/**
 * User-configurable talking-avatar overlay attached to a CommentatorRequest.
 * Mirrors the shape of LogoOverlay so the renderer can reuse position math.
 */
export interface AvatarOverlay {
	/** Master switch. false => pipeline behaves exactly as before. */
	enabled: boolean;
	/** Absolute path to the user-uploaded avatar image (prepped face crop). */
	imagePath: string;
	/** Corner/center placement on the 1080x1920 canvas. */
	position: AvatarPosition;
	/** Optional absolute X override (px). Wins over `position` when set. */
	x?: number;
	/** Optional absolute Y override (px). Wins over `position` when set. */
	y?: number;
	/** Avatar width as a fraction of canvas width (0-1). */
	scale: number;
	/** Margin from the canvas edge in px. */
	margin: number;
	/** Rounded framing. 'circle' masks the avatar into a circle. */
	shape: AvatarShape;
	/** Optional dedicated engine base URL. Empty => fall back to xttsColabUrl. */
	colabUrl?: string;
}

/**
 * Rendered avatar clips per commentary segment.
 * A = hook (talk), B = replay (idle), C = takeaway (talk).
 * Any missing segment simply has no avatar overlay for that span.
 */
export interface AvatarClips {
	segmentA?: string;
	segmentB?: string;
	segmentC?: string;
}

/** Safe defaults: OFF, so existing behavior is preserved by default. */
export const DEFAULT_AVATAR_OVERLAY: AvatarOverlay = {
	enabled: false,
	imagePath: '',
	position: 'bottom-right',
	scale: 0.28,
	margin: 48,
	shape: 'circle',
};

// ---------------------------------------------------------------------------
// Module augmentation (ADDITIVE)
// Extend the existing shared IPC types WITHOUT editing the large types.ts.
// These are type-only and erased at compile time, so runtime is unaffected.
// ---------------------------------------------------------------------------
declare module './types' {
	interface CommentatorRequest {
		/** Optional talking-avatar overlay. Omitted/disabled => pipeline unchanged. */
		avatar?: AvatarOverlay;
	}
	interface AppSettings {
		/** Optional dedicated avatar engine base URL. Empty => falls back to xttsColabUrl. */
		avatarColabUrl?: string;
	}
}
