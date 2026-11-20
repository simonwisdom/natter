# Natter: spec

Decisions in [§12](#12-decisions); changes made while building in §12a. Sections that depend on one name it (D1, D2, …).

## 1. Concept

A few people stand in front of a big screen (a MacBook for now) showing a highly visual, shared artifact. They talk about it freely. When someone raises a hand, the system listens to *that person*. When the hand comes down, it turns what they said into actions on the artifact, in about a second.

Three ideas carry the design:

1. **Floor control.** The raised hand is a signal everyone in the room can see: it means "I'm talking to the screen now". Conversation and commands never get mixed up, and there's no wake word.
2. **The body marks the boundaries.** Hand up starts a command and hand down ends it. Nothing has to guess when someone has finished speaking.
3. **The app exposes its own actions.** The interface publishes a typed list of actions and a description of what's on screen. The system picks from that list instead of scraping the screen.

Prior art: Richard Bolt, *Put-That-There* (MIT, 1980).

## 2. Goals and non-goals

**Goals (v1)**
- G1. A raised hand is detected and attributed to one person in under 300 ms, with few false triggers during normal conversation.
- G2. A spoken command produces a visible change **under 1.5 s (median) after the hand drops**.
- G3. Every change can be undone, by voice or by a key.
- G4. Anyone in the room can always tell whether the system is listening, and to whom.
- G5. No camera video or audio leaves the machine. Only transcripts and scene descriptions go to the model API.

**Non-goals (v1)**
- Listening to ambient conversation ("do what Sam just said"). It may come later as an explicit opt-in mode.
- Recognising faces or identities. People are "person 1, 2, 3" for the length of a session.
- Controlling arbitrary third-party apps.
- Precise pointing from a single webcam. v1 uses numbered badges (D7); a hand-as-cursor mode is a later experiment.
- More than about 4 people, or a range beyond about 3 m.

## 3. Room setup

- Screen: MacBook display in v1, an external display or TV later.
- Camera: the built-in FaceTime camera in v1 (about a 1–2.5 m working range). For a big screen, use a wide-angle USB camera mounted above it.
- Mic: the built-in mic array in v1. A USB boundary mic is the first upgrade if the room is noisy.
- People: 1–4, standing 1–3 m away, roughly facing the screen.

## 4. Interaction model

### 4.1 Floor-control state machine

```
          hand raised & held ≥ T_arm            speech + hand still up
 IDLE ─────────────────────────────► ARMED ─────────────────────────► LISTENING
  ▲                                    │ hand drops before T_arm         │ hand drops, or
  │                                    ▼                                 │ silence ≥ T_silence, or
  │                                  IDLE                                │ max length T_max
  │                                                                      ▼
  │    applied / rejected / cancelled                                RESOLVING
  └──────────────────────────────── APPLIED ◄── (preview) ◄──────────────┘
                                       │
                                       └─ a high-risk action waits in CONFIRMING
                                          (thumbs-up = confirm, a wave or timeout = cancel)
```

Proposed timings, to tune with real recordings: `T_arm` = 300 ms, `T_silence` = 1.5 s (a fallback for when the hand stays up), `T_max` = 20 s, `T_preroll` = 2 s.

Rules:
- **One person holds the floor at a time.** A second raised hand joins a visible queue and gets the floor when the current turn ends.
- **Pre-roll:** the utterance starts `T_preroll` before the arm event, because people start talking while they raise their hand.
- **Cancel:** the floor holder can say "cancel" or "never mind", or press Esc.
- **Undo** is an ordinary command ("undo", "put it back") and is also on a key.
- Other people's speech during LISTENING is captured too, since there's no speaker separation in v1. This is a known limitation (§10).

### 4.2 Feedback layer (always visible)

| Element | Shows | Notes |
|---|---|---|
| Camera picture-in-picture | stick figures of the tracked people, with the floor holder in their colour | never shows video |
| Screen-edge glow | LISTENING, in the floor holder's colour | readable from across the room |
| Caption bar | live transcript with a speaker label; grey italic when idle | |
| Target badges | numbers on addressable objects while LISTENING | an easy way to say "that one" (D7) |
| Preview | outlines and ghost positions for the resolved action | shown during RESOLVING → APPLIED |
| Toast | what was done, and how to undo it | |
| Queue chip | "Jon is next" | |

Mockup: the decide page "Gesture + voice: how the screen might look".

## 5. Architecture

**Browser page + local server (D1).** One web page runs the artifact (a purpose-built demo canvas, D5), the camera and mic capture, pose tracking (MediaPipe, D2) and the feedback layer. A local Python server (run with `uv`) runs speech recognition (Parakeet, D3) and the model calls, so API keys never reach the browser.

```
 ┌──────────────────────── Browser page ────────────────────────┐
 │ Camera → Pose tracker (MediaPipe, D2) → GestureEvents         │
 │ Mic → AudioRing (pre-roll buffer)                             │
 │            ↓                                                  │
 │       FloorController (state machine, §4.1)                   │
 │            │ utterance audio + gesture context                │
 │            ▼                                                  │
 │   ─── WebSocket to local server ────────────────────────────  │
 │                                                               │
 │ Artifact app ── ActionRegistry + SceneState + CommandBus      │
 │            ▲ validated ActionCalls                            │
 │ Feedback layer (§4.2)                                         │
 └───────────────────────────────────────────────────────────────┘
 ┌──────────────────────── Local server ────────────────────────┐
 │ STT: Parakeet via parakeet-mlx, streaming (D3)                │
 │ IntentResolver (§7): grammar → Haiku 4.5 → Sonnet 5.5 (D4)    │
 │ Trace log (every turn: inputs, outputs, timings)              │
 └───────────────────────────────────────────────────────────────┘
```

Components and what each owns:

| Component | Owns | Doesn't own |
|---|---|---|
| PoseTracker | landmarks per frame → `GestureEvent{personId, kind, hand, confidence, t}` | deciding who has the floor |
| FloorController | floor state, queue, utterance boundaries | understanding speech |
| AudioRing | the last `T_preroll` + current utterance | sending anything unless asked |
| STT | audio → transcript | intent |
| IntentResolver | transcript + scene → `ResolverResult` (§7.3) | changing the scene |
| CommandBus | validating, applying, previewing and undoing ActionCalls; **the only writer of scene state** | interpretation |
| Feedback layer | rendering floor, transcript, preview, toasts | state |

## 6. The action registry (the app's "interaction hooks")

The target app registers actions with schemas and a risk class:

```ts
registerAction({
  name: "groupItems",
  description: "Move items next to each other and label the group.",
  params: z.object({ ids: z.array(z.string()).min(1), label: z.string(), at: z.enum(["left","right","top","bottom"]).optional() }),
  risk: "low",              // low: apply now | high: needs a confirm gesture
  apply(scene, p) { … },    // returns the new scene and an inverse for undo
});
```

It also publishes a **SceneState snapshot** on every change:

```ts
{ version: 42,
  objects: [{ id: "c4", number: 4, kind: "image", label: "Lisbon tiles",
              props: { colour: "blue", tags: ["travel"] }, bbox: [x,y,w,h], group: "lisbon" }],
  selection: ["c4"],
  lastAction: { name: "groupItems", params: {…}, by: "person-2", version: 41 } }
```

Rules:
- Every change goes through the CommandBus, whatever its source (mouse, voice, keyboard). This gives one undo history and makes replay possible.
- An ActionCall carries the `sceneVersion` it was resolved against. The bus rejects calls against a stale version if their target ids have since changed.
- The resolver only sees actions registered **and allowed in the current state**. An action that can't be applied is never offered.
- Built-in actions that always exist: `undo`, `redo`, `cancel`, `clarify` (the resolver uses it to ask a question, §7.4).

## 7. Intent resolver

Designed using the multi-agent-system-design method. It is **one role**, not a team of agents. The tiers below are a latency optimisation inside that role, not separate agents.

### 7.1 Responsibility
Turn one final utterance into one of: an ordered list of ActionCalls, a clarifying question, or "no matching action". It never changes the scene itself.

### 7.2 Inputs (assembled per turn and logged)
- Final transcript, plus the partial transcripts (used for speculation, §8).
- SceneState snapshot: objects with ids, numbers, labels, props and positions; selection; lastAction.
- Gesture context: the floor holder's `personId` (and later, a hand-cursor target).
- The available actions with their JSON schemas.
- The previous turn (utterance and result), so repairs like "no, the other one" work.

### 7.3 Output contract
```ts
type ResolverResult =
  | { kind: "actions", calls: ActionCall[], sceneVersion: number, summary: string }
  | { kind: "clarify", question: string, candidates?: string[] }   // e.g. "Tom or Sam?"
  | { kind: "none", reason: "no_matching_action" | "not_a_command" }
  | { kind: "error", reason: "stt_failed" | "model_failed" | "timeout" };
```
Distinctions that must survive all the way to the screen: **ambiguous** vs **resolved**, **proposed** (preview) vs **applied**, and **"nothing matched"** vs **"the system failed"**. Each one gets its own visible feedback.

### 7.4 Tiers (D4)
1. **Grammar** (local, about 0 ms): undo, redo, cancel, next, zoom, "number N".
2. **Fast model** with tool calling (proposed: Claude Haiku 4.5). Actions are exposed as tools and the scene goes in the context. Most commands should resolve here.
3. **Strong model** (proposed: Claude Sonnet 5.5). Used when the fast model returns `clarify` with low confidence, or for compound or creative requests. It costs about another 1–2 s, so the screen says "thinking…".

### 7.5 Enforcement (code, not prompt)
| Rule | Enforced by |
|---|---|
| Only registered and allowed actions run | CommandBus validates each call against its zod schema and the allowed list |
| High-risk actions need a confirmation gesture | CommandBus holds them in CONFIRMING |
| No acting on a stale scene | `sceneVersion` check in the CommandBus |
| Only the floor holder can trigger | FloorController attaches `personId`; the bus rejects calls that come without a turn |
| Every change can be undone | `apply` must return an inverse; registration fails otherwise |

### 7.6 Evidence
Each turn writes one trace record: the gesture timeline, the audio clip reference, partial and final transcripts, the assembled resolver input, the raw model output, the result, scene versions before and after, and timings for each stage. The trace is how we tell "it said it worked" from "it worked".

## 8. Latency budget (median target)

| Stage | Budget |
|---|---|
| Hand down detected | 100 ms |
| Final transcript | 300 ms (only the tail is left to process) |
| Resolver, tiers 1–2 | 600 ms |
| Preview and apply | 200 ms (including a short preview animation) |
| **Total, hand down → visible change** | **≈ 1.2 s** |

Speculation: start resolving on stable partial transcripts while the hand is still up, then reuse the result if the final transcript matches.

## 9. Privacy and consent
- Pose tracking runs on-device. Frames are never stored or sent.
- Audio is held only in the rolling buffer until a turn starts, and is dropped after transcription unless trace recording is on.
- Trace recording is off by default, with a visible "recording" indicator when it's on.
- The first launch in a room shows a short notice explaining that the camera and mic are in use and what's kept.
- Speech recognition runs on-device (Parakeet). The only cloud traffic is the model calls: transcript, scene snapshot and action schemas. The README says so.

## 10. Failure modes and handling

| Failure | Handling |
|---|---|
| False hand-raise (a stretch or wave) | `T_arm` hold, a pose confidence threshold, and cancel by lowering the hand quickly |
| Hand-raise missed (out of frame, occluded) | hold-a-key fallback (D6), which drives the same FloorController |
| Crosstalk during LISTENING | caption shows what was heard, and undo is cheap. Speaker separation is out of scope for v1 |
| Mis-transcription | show the transcript prominently, and repair with "no, I said …" |
| Ambiguous target | `clarify` with numbered candidates |
| Model slow or failing | grammar tier still works, and the toast says "couldn't do that". Never a silent failure |
| Two people want the floor | queue |

## 11. Testing

- **Unit:** FloorController transitions driven by synthetic GestureEvent streams; CommandBus validation, undo and version checks.
- **Replay fixtures:** record real sessions as `{gesture events, audio, scene snapshots}`, then replay them through the pipeline deterministically (no camera needed) and check the **resulting scene state**, not the reply text.
- **Resolver evals:** a table of `(utterance, scene) → expected ResolverResult`, covering ordinary commands, repairs, ambiguity, non-commands and impossible requests. Run it on every resolver or prompt change, and track accuracy and latency per tier.
- **Break it on purpose:** disable a rule (for example the stale-version check) and confirm a test fails.
- **Room tests:** a scripted 10-minute session with 3 people, logging false triggers per minute, missed triggers, and the end-to-end latency distribution.

## 12. Decisions

| # | Decision | Choice | Notes |
|---|---|---|---|
| D1 | Runtime shape | browser page + local server | The server is Python (uv), because Parakeet runs in Python on MLX |
| D2 | Body tracking | MediaPipe in the browser | Behind a `GestureEvent` interface, so YOLO-pose could be swapped in later |
| D3 | Speech-to-text | on-device **Parakeet** via `parakeet-mlx` | `parakeet-mlx` has a streaming API (`StreamingParakeet`) for live captions. Latency to be measured in stage 2 |
| D4 | Intent resolver | grammar → Claude Haiku 4.5 → Claude Sonnet 5.5 | §7 |
| D5 | First target interface | purpose-built demo canvas in this repo | A moodboard of image and note cards. No real data or side effects. Mission-control could adopt the registry later |
| D6 | Trigger | hand raised above the shoulder, plus a hold-a-key fallback | No wake word, no palm gesture in v1 |
| D7 | Pointing in v1 | numbered badges only | Hand-as-cursor is a later experiment |
| D8 | Apply vs confirm | by risk class | low: apply now with undo. high: thumbs-up confirm. On the demo canvas only "clear board" and "delete" are high-risk |

## 12a. Changes made while building (v0.3)

- **Raised hand** means wrist above the nose (or well above the shoulder if the face isn't visible), not just above the shoulder, to cut false triggers. `web/src/input/people.ts`; tune it in room tests.
- **Ending a turn** is debounced (`T_RELEASE` = 250 ms of hand down) so a one-frame pose dropout doesn't cut someone off. Arming is not debounced.
- **There's no silence timeout**: a turn ends when the hand comes down, or at `T_MAX`.
- **Confirming a high-risk action** is by voice ("yes"/"no") or Enter/Esc, not a thumbs-up gesture. The pose model doesn't track fingers well enough; a hand landmarker could add it later.
- **Undo** restores whole-board snapshots instead of per-action inverses. It's simpler and covers every action, including batches.
- **Partial transcripts** re-run Parakeet on the whole utterance about every 350 ms instead of using its streaming decoder, which was less accurate in testing (a 3 s utterance takes about 90 ms).
- **The server** runs on port 8777, configurable with `NATTER_PORT`.
