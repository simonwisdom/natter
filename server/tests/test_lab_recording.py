from natter_server import app


def test_recording_pieces_are_appended_in_order_under_a_safe_name(tmp_path, monkeypatch):
    monkeypatch.setattr(app, "LAB_RECORDINGS", tmp_path / "rec")
    assert app.write_lab_recording("2026-11-17T10-00-00", b"one")
    assert app.write_lab_recording("2026-11-17T10-00-00", b"two")
    assert (tmp_path / "rec" / "2026-11-17T10-00-00.webm").read_bytes() == b"onetwo"
    # A name can't climb out of the folder.
    assert app.write_lab_recording("../../etc/x", b"data")
    assert sorted(p.name for p in (tmp_path / "rec").iterdir()) == ["2026-11-17T10-00-00.webm", "etcx.webm"]


def test_an_empty_piece_a_blank_name_or_a_full_session_saves_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(app, "LAB_RECORDINGS", tmp_path / "rec")
    assert not app.write_lab_recording("s", b"")
    assert not app.write_lab_recording("../", b"data")
    monkeypatch.setattr(app, "RECORDING_LIMIT", 5)
    assert app.write_lab_recording("s", b"12345")
    assert not app.write_lab_recording("s", b"6")
    assert (tmp_path / "rec" / "s.webm").read_bytes() == b"12345"


def test_a_new_recording_removes_the_oldest_ones_once_the_folder_is_too_big(tmp_path, monkeypatch):
    import os

    folder = tmp_path / "rec"
    monkeypatch.setattr(app, "LAB_RECORDINGS", folder)
    monkeypatch.setattr(app, "RECORDINGS_KEEP", 10)
    for i, name in enumerate(["old", "mid", "new"]):
        assert app.write_lab_recording(name, b"123456")
        os.utime(folder / f"{name}.webm", (1000 + i, 1000 + i))
    # Three files of 6 bytes with room for 10: starting a fourth leaves only the newest older one.
    assert app.write_lab_recording("now", b"1")
    assert sorted(p.name for p in folder.iterdir()) == ["new.webm", "now.webm"]
    # Adding to a recording already under way removes nothing.
    assert app.write_lab_recording("now", b"2")
    assert sorted(p.name for p in folder.iterdir()) == ["new.webm", "now.webm"]
    # Other files in the folder are never touched.
    (folder / "notes.txt").write_bytes(b"x" * 50)
    assert app.write_lab_recording("later", b"1")
    assert (folder / "notes.txt").exists()
