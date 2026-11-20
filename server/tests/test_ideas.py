import pytest

from natter_server import ideas


class FakeSession:
    def __init__(self, answer):
        self.answer = answer
        self.prompts = []

    def start(self):
        pass

    async def ask_text(self, prompt, tools, timeout):
        self.prompts.append((prompt, tools))
        return self.answer, {}


@pytest.fixture(autouse=True)
def no_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)


def test_prompt_carries_only_what_each_kind_needs():
    assert ideas.build_prompt("name", heard="um what if we stood up") == "<how>name</how>\n<heard>um what if we stood up</heard>"
    assert ideas.build_prompt("further", idea="Async updates") == "<how>further</how>\n<idea>Async updates</idea>"
    assert "<other>Demo Fridays</other>" in ideas.build_prompt("combine", idea="Async updates", other="Demo Fridays")
    with pytest.raises(ideas.IdeaError):
        ideas.build_prompt("sideways", idea="x")


def test_parse_tolerates_a_code_fence_and_trims_the_label():
    assert ideas.parse('```json\n{"text": "No meeting at all.", "emoji": "🚫"}\n```') == {"text": "No meeting at all", "emoji": "🚫"}
    assert ideas.parse('{"text": "Voice notes"}') == {"text": "Voice notes", "emoji": ""}
    for bad in ("sorry, no", '{"text": ""}', "{not json}"):
        with pytest.raises(ideas.IdeaError):
            ideas.parse(bad)


def test_a_label_that_reaches_the_limit_ends_on_a_whole_word():
    assert ideas.parse('{"text": "Teaching animals to alert to panic attac"}')["text"] == "Teaching animals to alert to panic…"
    assert ideas.parse('{"text": "Teaching animals to alert to panic attacks before they start"}')["text"] == "Teaching animals to alert to panic…"
    assert ideas.parse('{"text": "Animals as therapists in hospitals"}')["text"] == "Animals as therapists in hospitals"
    assert len(ideas.parse('{"text": "' + "a" * 60 + '"}')["text"]) == ideas.MAX_LABEL


async def test_rework_goes_through_claude_code_without_a_key():
    session = FakeSession('{"text": "Async, then demo Fridays", "emoji": "🎬"}')
    answer = await ideas.Reworker(session=session).rework("combine", idea="Async updates", other="Demo Fridays")
    assert answer["text"] == "Async, then demo Fridays" and answer["emoji"] == "🎬" and "ms" in answer
    prompt, tools = session.prompts[0]
    assert tools is None and "<how>combine</how>" in prompt


async def test_a_useless_answer_is_an_idea_error():
    with pytest.raises(ideas.IdeaError):
        await ideas.Reworker(session=FakeSession("I can't help with that")).rework("further", idea="x")


async def test_zone_context_reaches_both_model_prompts():
    session = FakeSession('{"text": "Walk there", "emoji": "🚶"}')
    reworker = ideas.Reworker(session=session)
    await reworker.rework("smaller", idea="Trip", zone="Nearby", board=["Park"])
    assert "<zone>Nearby</zone>\n<board>\n- Park\n</board>" in session.prompts[-1][0]
    session.answer = '{"ideas": [{"text": "Picnic", "emoji": "🧺"}]}'
    await reworker.suggest("Trip", ["Walk there"], ["Park"], zone="Nearby")
    assert "<zone>Nearby</zone>\n<board>\n- Park\n</board>" in session.prompts[-1][0]
    assert "<branches>\n- Walk there\n</branches>" in session.prompts[-1][0]
    session.answer = '{"text": "Walk there", "emoji": "🚶"}'
    await reworker.rework("smaller", idea="Trip", zone="Empty", board=[])
    assert "<zone>Empty</zone>\n<board>\n(none)\n</board>" in session.prompts[-1][0]


def test_idea_conversations_do_not_keep_context_from_previous_zones():
    assert ideas.Reworker()._session.recycle_after == 1


def test_suggest_prompt_lists_what_is_already_there():
    prompt = ideas.build_suggest_prompt("Async updates", ["Voice notes"], [])
    assert "<idea>Async updates</idea>" in prompt and "- Voice notes" in prompt and "<board>\n(none)\n</board>" in prompt


def test_parse_ideas_keeps_the_usable_ones():
    text = '{"ideas": [{"text": "Voice notes", "emoji": "🎙️"}, {"text": ""}, {"text": "Shared doc.", "emoji": "📄"}]}'
    assert ideas.parse_ideas(text) == [{"text": "Voice notes", "emoji": "🎙️"}, {"text": "Shared doc", "emoji": "📄"}]
    with pytest.raises(ideas.IdeaError):
        ideas.parse_ideas('{"ideas": []}')


def test_parse_structure_checks_and_clamps():
    ids = {"b1", "b2"}
    axes = '{"kind": "axes", "x": ["easy", "hard"], "y": ["small win", "big win"], "place": [{"id": "b1", "x": 0.2, "y": 1.4}, {"id": "ghost", "x": 0.5, "y": 0.5}]}'
    assert ideas.parse_structure(axes, ids) == {"kind": "axes", "x": ["easy", "hard"], "y": ["small win", "big win"], "place": [{"id": "b1", "x": 0.2, "y": 1.0}]}
    zones = '{"kind": "zones", "zones": ["Now", "Later", "Never"], "place": [{"id": "b1", "zone": 2}, {"id": "b2", "zone": 7}]}'
    assert ideas.parse_structure(zones, ids) == {"kind": "zones", "zones": ["Now", "Later", "Never"], "place": [{"id": "b1", "zone": 2}]}
    assert ideas.parse_structure('{"kind": "clear"}', ids) == {"kind": "clear"}
    for bad in ('{"kind": "axes", "x": ["easy"], "y": ["a", "b"]}', '{"kind": "zones", "zones": ["only one"]}', '{"kind": "spiral"}'):
        with pytest.raises(ideas.IdeaError):
            ideas.parse_structure(bad, ids)


async def test_structure_goes_through_one_prompt_with_the_board():
    session = FakeSession('{"kind": "zones", "zones": ["Now", "Later"], "place": [{"id": "b1", "zone": 0}]}')
    answer = await ideas.Reworker(session=session).structure("now and later piles", [{"id": "b1", "text": "Async updates"}])
    assert answer["kind"] == "zones" and answer["place"] == [{"id": "b1", "zone": 0}]
    prompt = ideas.build_structure_prompt("by colour", [{"id": "b2", "text": "Voice notes", "family": "Async updates", "colour": "blue", "starred": True}])
    assert "b2: Voice notes (family: Async updates, colour: blue, starred)" in prompt
    assert "b1: Async updates" in session.prompts[0][0] and "<heard>now and later piles</heard>" in session.prompts[0][0]


def test_suggest_prompt_carries_the_other_idea_and_the_angle_only_when_given():
    plain = ideas.build_suggest_prompt("Long walk", [], ["Sleep in"])
    assert "<other>" not in plain and "<angle>" not in plain
    assert ideas.build_suggest_prompt("Long walk", [], [], other="  ", angle="  ") == ideas.build_suggest_prompt("Long walk", [], [])
    pair = ideas.build_suggest_prompt("Long walk", ["Fresh air"], ["Sleep in"], other="Read in the park", angle=" similarities ")
    assert pair.startswith("<how>suggest</how>\n<idea>Long walk</idea>\n<other>Read in the park</other>\n<angle>similarities</angle>\n<branches>\n- Fresh air\n</branches>")
    assert "<angle>risks</angle>" in ideas.build_suggest_prompt("Long walk", [], [], angle="risks")


async def test_suggest_returns_the_angle_claude_understood_only_when_one_was_said():
    answer = '{"ideas": [{"text": "Both outdoors", "emoji": "🌤️"}, {"text": "No screens", "emoji": "📵"}], "angle": " Similarities. "}'
    session = FakeSession(answer)
    reworker = ideas.Reworker(session=session)
    said = await reworker.suggest("Long walk", [], [], other="Read in the park", angle="similar it ease")
    assert said["angle"] == "Similarities" and len(said["ideas"]) == 2
    assert "<other>Read in the park</other>\n<angle>similar it ease</angle>" in session.prompts[-1][0]
    # Nothing was said: an angle the model volunteers is not put on the line.
    assert (await reworker.suggest("Long walk", [], []))["angle"] == ""
    # Something was said, but Claude judged it wasn't an angle and left it out.
    session.answer = '{"ideas": [{"text": "Both outdoors", "emoji": "🌤️"}]}'
    assert (await reworker.suggest("Long walk", [], [], angle="hang on a sec"))["angle"] == ""
    session.answer = '{"ideas": [{"text": "Both outdoors", "emoji": "🌤️"}], "angle": 7}'
    assert (await reworker.suggest("Long walk", [], [], angle="risks"))["angle"] == ""
    assert len(ideas.parse_angle('{"angle": "' + "x" * 80 + '"}')) == ideas.MAX_ANGLE


async def test_an_area_is_named_from_its_ideas_alone():
    prompt = ideas.build_prompt("area", board=["Jiu Jitsu", "Capoeira"])
    assert prompt == "<how>area</how>\n<board>\n- Jiu Jitsu\n- Capoeira\n</board>"
    assert "<idea>" not in ideas.build_prompt("area", idea="ignored", zone="Now", board=["x"])
    session = FakeSession('{"text": "Martial arts", "emoji": "🥋"}')
    named = await ideas.Reworker(session=session).rework("area", board=["Jiu Jitsu", "Capoeira"])
    assert named["text"] == "Martial arts" and named["emoji"] == "🥋"
    assert session.prompts[-1][0] == prompt


def test_suggest_prompt_lists_a_hubs_linked_ideas_only_when_given():
    plain = ideas.build_suggest_prompt("Spaces that make you think", [], ["Sleep in"])
    assert "<linked>" not in plain
    assert ideas.build_suggest_prompt("Spaces that make you think", [], ["Sleep in"], linked=[" ", ""]) == plain
    hub = ideas.build_suggest_prompt("Spaces that make you think", ["Desk by a window"], ["Sleep in"], linked=["Work", "Socializing", "Exercising"], angle="cheaper")
    assert hub.startswith("<how>suggest</how>\n<idea>Spaces that make you think</idea>\n<linked>\n- Work\n- Socializing\n- Exercising\n</linked>\n<angle>cheaper</angle>\n<branches>\n- Desk by a window\n</branches>")
    assert "<linked>" in ideas.SYSTEM and "<linked>" in ideas.LOCAL_SYSTEM


class Answers:
    """A session that gives its answers in turn."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.prompts = []

    def start(self):
        pass

    async def ask_text(self, prompt, tools, timeout):
        self.prompts.append(prompt)
        return self.answers.pop(0), {}


async def test_a_spoken_idea_claude_answers_with_a_question_keeps_the_words_heard():
    session = FakeSession("I need more context to create a label. Could you tell me what idea the person means?")
    answer = await ideas.Reworker(session=session).rework("name", heard="Oh no way.  Oh that's really cool.")
    assert answer["text"] == "Oh no way. Oh that's really cool" and answer["emoji"]
    long = await ideas.Reworker(session=session).rework("name", heard="and then everything in the zone gets ideas generated and they stay here")
    assert long["text"] == "and then everything in the zone…"


async def test_an_ask_claude_answers_with_a_question_is_asked_again_without_the_words_said():
    session = Answers('I am not sure what "Yeah to you" means as an angle. Could you say it again?', '{"ideas": [{"text": "Picnic", "emoji": "🧺"}, {"text": "Night walk", "emoji": "🌙"}]}')
    answer = await ideas.Reworker(session=session).suggest("Trip", [], [], angle="Yeah to you.")
    assert [i["text"] for i in answer["ideas"]] == ["Picnic", "Night walk"] and answer["angle"] == ""
    assert "<angle>" in session.prompts[0] and "<angle>" not in session.prompts[1]


async def test_an_ask_with_nothing_said_that_fails_is_still_an_error():
    with pytest.raises(ideas.IdeaError):
        await ideas.Reworker(session=FakeSession("What would you like?")).suggest("Trip", [], [])
