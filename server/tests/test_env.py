from natter_server import app


def test_key_added_to_env_file_is_picked_up_without_restart(tmp_path, monkeypatch):
    monkeypatch.setattr(app, "ROOT", tmp_path)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.setattr(app, "_env_key", None)
    assert app.status()["llm"] == "claude_code"

    app.resolver._client = object()  # stands in for a client built with the old key
    (tmp_path / ".env").write_text("ANTHROPIC_API_KEY=sk-test\n")
    assert app.status()["llm"] == "ready"
    assert app.resolver._client is None
    monkeypatch.delenv("ANTHROPIC_API_KEY")
