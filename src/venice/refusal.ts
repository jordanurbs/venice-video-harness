// ---------------------------------------------------------------------------
// Refusal classification -- pure. Plain data in, plain data out.
//
// Venice reports two kinds of "no" that look alike in the error text but need
// opposite handling:
//
//   1. provider_content_policy -- the model's provider refused the request
//      under its own content rules. The body says whether credits were
//      refunded and may suggest a model whose filter judges differently:
//
//        { "error": { "type": "provider_content_policy",
//                     "message": "Your prompt violates the content policy",
//                     "credits_refunded": true,
//                     "recommended_model": "wan-3-0-reference-to-video" } }
//
//      A provider filter is not deterministic: the same request has passed on
//      a second try. So a REFUNDED refusal is worth exactly one more attempt;
//      an unrefunded one is not (it bills again); and a second identical
//      refusal is final -- surface `recommended_model`.
//
//   2. Face screening on `/video/queue` -- before queueing a job on a
//      face-capable Seedance id, Venice registers every image that shows a
//      face with the provider. An image the provider will not take comes back
//      as a 422 whose message blames "the prompt", though the prompt was never
//      judged and nothing was queued or charged. Live tests (2026-10-01): the
//      same image was refused five times under three different prompts and as
//      a crop of the face alone; prompt wording never mattered. Operators who
//      read the raw message rewrite prompts for hours. This is an IMAGE
//      problem and the message must say so.
// ---------------------------------------------------------------------------

export interface ProviderRefusal {
  /** `error.credits_refunded`. False when the model bills for refused requests, so a retry is paid for twice. */
  creditsRefunded: boolean;
  /** `error.recommended_model`: Venice's suggestion of a model whose filter may judge the request differently. */
  recommendedModel?: string;
  /** The provider's message, verbatim. */
  message: string;
}

/** The provider-refusal details of an error body, when it is one. */
export function parseProviderRefusal(body: unknown): ProviderRefusal | undefined {
  const error = (body as { error?: unknown } | null | undefined)?.error;
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as Record<string, unknown>;
  if (e.type !== 'provider_content_policy') return undefined;
  return {
    creditsRefunded: e.credits_refunded === true,
    ...(typeof e.recommended_model === 'string' && e.recommended_model
      ? { recommendedModel: e.recommended_model }
      : {}),
    message: typeof e.message === 'string' ? e.message : 'The provider refused this request under its content policy.',
  };
}

export type VideoRefusalKind =
  /** Seedance face screening refused an image at queue time. Nothing queued or charged. Same images fail every time. */
  | 'face-screening'
  /** The provider's content filter refused the request (after it ran, or at queue). */
  | 'provider-content-policy';

export interface VideoRefusal {
  kind: VideoRefusalKind;
  model: string;
  /** Present for `provider-content-policy`; a face-screening 422 has no structured body. */
  refusal?: ProviderRefusal;
  /** Whether one more attempt with the same request is worth making. */
  retryable: boolean;
  /** What to tell the operator. */
  message: string;
}

const IMAGE_INPUT_KEYS = [
  'image_url', 'end_image_url', 'reference_image_urls', 'scene_image_urls', 'video_url', 'reference_video_urls',
] as const;

/** True when the request body carries any image or video input. */
export function requestHasImageInput(body: Record<string, unknown>): boolean {
  if (IMAGE_INPUT_KEYS.some(key => (Array.isArray(body[key]) ? (body[key] as unknown[]).length > 0 : body[key] !== undefined))) {
    return true;
  }
  const elements = body.elements;
  return Array.isArray(elements) && elements.some(el => {
    const e = el as Record<string, unknown> | null;
    return Boolean(e?.frontal_image_url) || (Array.isArray(e?.reference_image_urls) && e!.reference_image_urls.length > 0);
  });
}

/** A face-capable Seedance id: the plain lane, not the `-basic` faces-off twin (which has no screening to refuse). */
function isFaceCapableSeedance(model: string): boolean {
  const id = model.toLowerCase();
  return id.startsWith('seedance-') && !/-basic$/.test(id);
}

export const FACE_SCREENING_MESSAGE =
  "Seedance's face screening refused an image in this request (a face in the start frame or a reference image), "
  + 'not the prompt. The same images are refused every time; rewording the prompt will not help. '
  + 'Nothing was queued or charged. Regenerate or replace the refused character reference / panel, then retry.';

/**
 * Classify a failed `POST /video/queue`. Returns `undefined` when the error is
 * not a refusal (a 400 validation error, a 5xx, a 401...).
 *
 * @param input.status       HTTP status of the failed call.
 * @param input.message      The human message already extracted from the body.
 * @param input.body         The parsed error body.
 * @param input.model        The model the request named.
 * @param input.requestBody  The body that was sent (to see whether images went with it).
 * @param input.priorRefusals  How many times this exact request has already been refused. A
 *                             refunded refusal is retryable only when this is 0.
 */
export function classifyVideoQueueRefusal(input: {
  status: number;
  message: string;
  body: unknown;
  model: string;
  requestBody: Record<string, unknown>;
  priorRefusals?: number;
}): VideoRefusal | undefined {
  const { status, message, body, model, requestBody } = input;
  const prior = input.priorRefusals ?? 0;

  const refusal = parseProviderRefusal(body);
  if (refusal) {
    const retryable = refusal.creditsRefunded && prior === 0;
    const tail = retryable
      ? ' Credits were refunded; retrying once.'
      : refusal.creditsRefunded
        ? ` Refused again with the same request${refusal.recommendedModel ? `; Venice recommends ${refusal.recommendedModel}` : ''}. Credits were refunded.`
        : ` Credits were NOT refunded, so this is not retried${refusal.recommendedModel ? `; Venice recommends ${refusal.recommendedModel}` : ''}.`;
    return {
      kind: 'provider-content-policy',
      model,
      refusal,
      retryable,
      message: `${model} refused this request under its provider's content policy: ${refusal.message}.${tail}`,
    };
  }

  // Face screening: a 422 "content policy" on a face-capable Seedance id with
  // images in the request, and no structured provider_content_policy body.
  if (status === 422 && /content policy/i.test(message) && isFaceCapableSeedance(model) && requestHasImageInput(requestBody)) {
    return { kind: 'face-screening', model, retryable: false, message: FACE_SCREENING_MESSAGE };
  }

  return undefined;
}
