import pytest


@pytest.fixture(autouse=True)
def offline_models(monkeypatch):
    """Unit tests never contact a real local or paid model."""
    monkeypatch.setenv("NATTER_OLLAMA_MODEL", "")
