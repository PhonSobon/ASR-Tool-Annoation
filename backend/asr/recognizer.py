"""Omnilingual-ASR-Khm, loaded once on first use and run one request at a time."""
import threading

_model = {"asr": None}
_lock = threading.Lock()


def recognize(audio, model_source):
    """Transcribe 16 kHz float audio. Returns {"text", "words"}; word times are relative to the clip."""
    from backend.asr.omni_asr import OmniASR

    with _lock:
        if _model["asr"] is None:
            print(f"[Omni-ASR] loading {model_source}", flush=True)
            _model["asr"] = OmniASR(model_source)
        return _model["asr"].recognize_array(audio)
