"""FrameFlow MiniMax H3 Context Loop extension.

The original Context Loop package remains untouched.  This FrameFlow fork
adds two deliberately unique nodes:

* pre-encode every cut while the 15 GB text encoder is resident;
* select the cached conditioning inside the recursive scene loop.

It also adds a narrow ``cond_audio`` adapter for older MiniMaxH3-Cache forward
patches, without replacing Comfy's mask engine or editing either installed
upstream package.
"""

import copy
import functools

import node_helpers
import comfy.ldm.minimax.model as minimax_model

from comfy_extras.nodes_minimax_h3 import (
    FPS,
    _empty_av_latent,
    _encode_ref_audio,
    _resize,
    adapt_canvas,
)


MAX_SHOTS = 128
BANK_TYPE = "FRAMEFLOW_H3_CONDITIONING_BANK"


def _enable_context_loop_audio_compat():
    """Adapt only the missing ``cond_audio`` segment in older cache patches.

    MiniMaxH3-Cache versions predating native generated-audio continuation know
    ``ref_audio`` but raise ``KeyError('cond_audio')``.  Both segment kinds use
    the same audio-conditioning timestep and modality tag.  A shallow layout
    copy lets the old forward use that already-correct path without replacing
    Comfy's model, mask engine, or the installed cache package.
    """

    model_class = getattr(minimax_model, "MiniMaxH3Model", None)
    current = getattr(model_class, "_forward", None) if model_class else None
    marker = "_frameflow_cond_audio_adapter_v1"
    if current is None or getattr(current, marker, False):
        return

    @functools.wraps(current)
    def wrapped(self, *args, minimax_payload=None, **kwargs):
        payload = minimax_payload
        layout = payload.get("layout") if isinstance(payload, dict) else None
        if layout is not None and any(
            kind == "cond_audio" for _, _, kind in layout.segments
        ):
            layout_copy = copy.copy(layout)
            layout_copy.segments = [
                (start, stop, "ref_audio" if kind == "cond_audio" else kind)
                for start, stop, kind in layout.segments
            ]
            payload = dict(payload)
            payload["layout"] = layout_copy
        return current(self, *args, minimax_payload=payload, **kwargs)

    setattr(wrapped, marker, True)
    model_class._forward = wrapped
    print("[FrameFlow H3] cond_audio compatibility adapter is active.")


_enable_context_loop_audio_compat()


class FrameFlowH3ConditioningPrefetch:
    @classmethod
    def INPUT_TYPES(cls):
        required = {
            "clip": ("CLIP",),
            "vae": ("VAE",),
            "width": ("INT", {"default": 1344, "min": 32, "step": 32}),
            "height": ("INT", {"default": 768, "min": 32, "step": 32}),
            "prompt_1": ("STRING", {"multiline": True}),
            "length_1": ("INT", {"default": 124, "min": 5, "step": 17}),
            "last_frame_1": ("IMAGE",),
        }
        optional = {"first_frame": ("IMAGE",)}
        for index in range(2, MAX_SHOTS + 1):
            optional[f"prompt_{index}"] = ("STRING", {"multiline": True})
            optional[f"length_{index}"] = (
                "INT",
                {"default": 124, "min": 5, "step": 17},
            )
            optional[f"last_frame_{index}"] = ("IMAGE",)
        return {"required": required, "optional": optional}

    RETURN_TYPES = (BANK_TYPE, "STRING")
    RETURN_NAMES = ("bank", "status")
    FUNCTION = "prefetch"
    CATEGORY = "FrameFlow/Minimax H3"

    def prefetch(
        self,
        clip,
        vae,
        width,
        height,
        prompt_1,
        length_1,
        last_frame_1,
        first_frame=None,
        **kwargs,
    ):
        entries = []
        for index in range(1, MAX_SHOTS + 1):
            prompt = prompt_1 if index == 1 else kwargs.get(f"prompt_{index}")
            length = length_1 if index == 1 else kwargs.get(f"length_{index}")
            last = last_frame_1 if index == 1 else kwargs.get(f"last_frame_{index}")
            if prompt is None or length is None or last is None:
                break

            latent, frame_count = _empty_av_latent(width, height, length)
            images = []
            keyframes = []
            if index == 1 and first_frame is not None:
                image = _resize(first_frame[:1], width, height, "disabled")
                images.append(image)
                keyframes.append({"resolved_frame_index": 0, "image": image})
            image = _resize(last[:1], width, height, "center")
            images.append(image)
            keyframes.append(
                {"resolved_frame_index": frame_count - 1, "image": image}
            )
            entries.append(
                {
                    "prompt": str(prompt),
                    "images": images,
                    "keyframes": keyframes,
                    "latent": latent,
                }
            )

        if not entries:
            raise ValueError("FrameFlow H3 prefetch received no cuts.")

        # Phase 1: encode every prompt/image token set consecutively.  Keeping
        # this in one node prevents the scheduler from alternating the 15 GB
        # text encoder with the 20 GB diffusion model between cuts.
        conditionings = []
        for entry in entries:
            tokens = clip.tokenize(entry["prompt"], images=entry["images"])
            conditionings.append(clip.encode_from_tokens_scheduled(tokens))

        # Phase 2: encode all visual anchors after the text pass.  The video
        # VAE may now replace/offload CLIP once, rather than once per cut.
        bank = []
        for entry, conditioning in zip(entries, conditionings):
            keyframes = []
            for keyframe in entry["keyframes"]:
                keyframes.append(
                    {
                        "resolved_frame_index": keyframe["resolved_frame_index"],
                        "latent": vae.encode(keyframe["image"]),
                    }
                )
            conditioning = node_helpers.conditioning_set_values(
                conditioning, {"minimax_keyframes": keyframes}
            )
            bank.append((conditioning, entry["latent"]))

        return (bank, f"prefetched {len(bank)} H3 cut conditionings")


class FrameFlowH3ConditioningSelect:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "state": ("H3_CHAIN_STATE",),
                "bank": (BANK_TYPE,),
            }
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT", "STRING")
    RETURN_NAMES = ("conditioning", "latent", "status")
    FUNCTION = "select"
    CATEGORY = "FrameFlow/Minimax H3"

    def select(self, state, bank):
        index = max(1, int(state.get("index", 1)))
        if index > len(bank):
            raise ValueError(
                f"FrameFlow H3 conditioning bank has no cut {index} "
                f"(available: {len(bank)})."
            )
        conditioning, latent = bank[index - 1]
        return conditioning, latent, f"cut {index}: prefetched conditioning"


class FrameFlowH3Ref2VAConditioningPrefetch:
    """Encode one shared Ref2VA library against every cut prompt up front.

    The resulting bank is consumed by the existing Context Loop selector.  This
    keeps Picture/Video/Audio reference tokens on every cut while allowing the
    chain node to inject the previous clip's final 22 latent frames.
    """

    @classmethod
    def INPUT_TYPES(cls):
        required = {
            "clip": ("CLIP",),
            "vae": ("VAE",),
            "audio_vae": ("VAE",),
            "width": ("INT", {"default": 1344, "min": 32, "step": 32}),
            "height": ("INT", {"default": 768, "min": 32, "step": 32}),
            "ref_image_size": (["match", "max"], {"default": "match"}),
            "prompt_1": ("STRING", {"multiline": True}),
            "length_1": ("INT", {"default": 124, "min": 5, "step": 17}),
        }
        optional = {}
        for index in range(2, MAX_SHOTS + 1):
            optional[f"prompt_{index}"] = ("STRING", {"multiline": True})
            optional[f"length_{index}"] = (
                "INT", {"default": 124, "min": 5, "step": 17})
        for index in range(1, 10):
            optional[f"ref_image_{index}"] = ("IMAGE",)
        for index in range(1, 4):
            optional[f"ref_video_{index}"] = ("IMAGE",)
            optional[f"ref_video_audio_{index}"] = ("AUDIO",)
            optional[f"ref_audio_{index}"] = ("AUDIO",)
        return {"required": required, "optional": optional}

    RETURN_TYPES = (BANK_TYPE, "STRING")
    RETURN_NAMES = ("bank", "status")
    FUNCTION = "prefetch"
    CATEGORY = "FrameFlow/Minimax H3"

    def prefetch(self, clip, vae, audio_vae, width, height, ref_image_size,
                 prompt_1, length_1, **kwargs):
        ref_items = []
        ref_blocks = []

        for index in range(1, 10):
            image = kwargs.get(f"ref_image_{index}")
            if image is None:
                continue
            h, w = image.shape[1], image.shape[2]
            if ref_image_size == "match":
                scale = min(1.0, ((width * height) / (w * h)) ** 0.5)
            else:
                scale = min(1.0, 2048 / min(w, h))
            tw = max(32, round(w * scale / 32) * 32)
            th = max(32, round(h * scale / 32) * 32)
            resized = _resize(image[:1], tw, th, "disabled")
            ref_items.append({"type": "image", "data": resized})
            ref_blocks.append({"kind": "image", "latent_h": th // 16,
                               "latent_w": tw // 16, "latent": vae.encode(resized)})

        for index in range(1, 4):
            frames = kwargs.get(f"ref_video_{index}")
            if frames is None:
                continue
            soundtrack = kwargs.get(f"ref_video_audio_{index}")
            vh, vw = frames.shape[1], frames.shape[2]
            cw, ch = adapt_canvas(vw, vh)
            if vw * vh < cw * ch:
                cw = max(32, round(vw / 32) * 32)
                ch = max(32, round(vh / 32) * 32)
            frames = _resize(frames, cw, ch, "disabled")
            n = min(frames.shape[0], 3600)
            while n >= 5 and n % 17 != 5:
                n -= 1
            if n < 5:
                raise ValueError("MiniMax H3 reference videos need at least 5 frames")
            frames = frames[:n]
            video_latent = vae.encode(frames)
            audio_latent, ref_audio_t = (None, 0)
            if soundtrack is not None:
                audio_latent, ref_audio_t = _encode_ref_audio(audio_vae, soundtrack)
                ref_items.append({"type": "audio"})
            sample_idx = list(range(0, frames.shape[0], FPS // 2))
            ref_items.append({"type": "video", "data": frames[sample_idx],
                              "timestamps": [i / 2.0 for i in range(len(sample_idx))]})
            ref_blocks.append({"kind": "video_audio" if ref_audio_t else "video",
                               "latent_t": video_latent.shape[2],
                               "latent_h": ch // 16, "latent_w": cw // 16,
                               "ref_audio_t": ref_audio_t, "latent": video_latent,
                               "audio_latent": audio_latent})

        for index in range(1, 4):
            audio = kwargs.get(f"ref_audio_{index}")
            if audio is None:
                continue
            audio_latent, ref_audio_t = _encode_ref_audio(audio_vae, audio)
            ref_items.append({"type": "audio"})
            ref_blocks.append({"kind": "audio", "ref_audio_t": ref_audio_t,
                               "audio_latent": audio_latent})

        entries = []
        for index in range(1, MAX_SHOTS + 1):
            prompt = prompt_1 if index == 1 else kwargs.get(f"prompt_{index}")
            length = length_1 if index == 1 else kwargs.get(f"length_{index}")
            if prompt is None or length is None:
                break
            latent, _ = _empty_av_latent(width, height, length)
            tokens = clip.tokenize(str(prompt), minimax_ref_items=ref_items)
            conditioning = clip.encode_from_tokens_scheduled(tokens)
            if ref_blocks:
                conditioning = node_helpers.conditioning_set_values(
                    conditioning, {"minimax_refs": ref_blocks})
            entries.append((conditioning, latent))
        if not entries:
            raise ValueError("FrameFlow Ref2VA prefetch received no cuts.")
        return entries, f"prefetched {len(entries)} Ref2VA cut conditionings"


NODE_CLASS_MAPPINGS = {
    "FrameFlowH3ConditioningPrefetch": FrameFlowH3ConditioningPrefetch,
    "FrameFlowH3Ref2VAConditioningPrefetch": FrameFlowH3Ref2VAConditioningPrefetch,
    "FrameFlowH3ConditioningSelect": FrameFlowH3ConditioningSelect,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "FrameFlowH3ConditioningPrefetch": "FrameFlow H3 Conditioning Prefetch",
    "FrameFlowH3Ref2VAConditioningPrefetch": "FrameFlow H3 Ref2VA Conditioning Prefetch",
    "FrameFlowH3ConditioningSelect": "FrameFlow H3 Conditioning Select",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
