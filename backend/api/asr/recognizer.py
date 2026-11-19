"""Sota-ASR-Khmer-ONNX, loaded once on first use and run one request at a time."""
import threading

_model = {"asr": None, "source": None}
_lock = threading.Lock()


def recognize(audio, model_source):
    """Transcribe 16 kHz float audio. Returns {"text", "words"}; word times are relative to the clip."""
    from api.asr.sota_asr import SotaASR

    with _lock:
        if _model["asr"] is None or _model["source"] != model_source:
            print(f"[Sota-ASR] loading {model_source}", flush=True)
            _model["asr"], _model["source"] = SotaASR(model_source), model_source
        return _model["asr"].recognize_array(audio)
