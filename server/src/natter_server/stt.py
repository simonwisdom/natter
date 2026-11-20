"""Speech-to-text with Parakeet on MLX.

Utterances are short (under 20 s), and a full pass over 3 s of audio takes about
90 ms warm, so partials re-transcribe the whole buffer rather than using the
streaming decoder, which was noticeably less accurate in testing.
"""

import threading
import time

import mlx.core as mx
import numpy as np
from parakeet_mlx import from_pretrained
from parakeet_mlx.audio import get_logmel

MODEL_ID = "mlx-community/parakeet-tdt-0.6b-v3"
SAMPLE_RATE = 16000


class Transcriber:
    def __init__(self, model_id: str = MODEL_ID):
        self.model_id = model_id
        self._model = None
        self._lock = threading.Lock()  # MLX work stays on one thread at a time

    @property
    def ready(self) -> bool:
        return self._model is not None

    def load(self) -> float:
        start = time.perf_counter()
        self._model = from_pretrained(self.model_id)
        self.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))  # warm up
        return time.perf_counter() - start

    def transcribe(self, audio: np.ndarray) -> str:
        if self._model is None:
            raise RuntimeError("speech model not loaded")
        if len(audio) < SAMPLE_RATE // 10:
            return ""
        with self._lock:
            mel = get_logmel(mx.array(audio), self._model.preprocessor_config)
            result = self._model.generate(mel)
        result = result[0] if isinstance(result, list) else result
        return result.text.strip()
