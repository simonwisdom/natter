# Developing Natter

Notes for working on the code. For what Natter is and how to start it, see `README.md`. The design of the original raised-hand board is in `SPEC.md`.

## Run it

You need an Apple silicon Mac, Node 24, [uv](https://docs.astral.sh/uv/) and Chrome.

```bash
cp .env.example .env      # optional: NATTER_LLM=local for a local model only, or ANTHROPIC_API_KEY to use the paid API instead of your Claude Code login
./run.sh install          # builds the web app and runs the server as a background service
```

The service starts at login and restarts itself if it crashes; its log is `~/Library/Logs/natter.log`. The server rereads `.env` before each command, so adding or changing the key needs no restart (reload the page to update the status dots). After changing code, `./run.sh restart` rebuilds and restarts it; `./run.sh stop` stops it for good. `./run.sh` alone runs it in the foreground instead.

Open **http://127.0.0.1:8777** in Chrome, click **Start camera and microphone**, and allow both. The browser itself also needs camera and microphone access in **System Settings → Privacy & Security**; without it the camera fails with "Permission denied by system" and no prompt appears.

Open **Inputs** at the bottom right on either board to choose a camera or microphone, then press **Use camera** or **Use microphone**. Successful choices are remembered in this browser. **Refresh devices** updates the lists after plugging in a device. Finish any voice turn before switching inputs.

The first start downloads the Parakeet speech model (about 2.3 GB, a few minutes). After that it loads in a couple of seconds. The row of dots under the title shows the server, speech model, LLM, camera and microphone status.

### On an iPhone

Safari only allows the camera and microphone over HTTPS, so the phone reaches the Mac through [Tailscale](https://tailscale.com), which gives the Mac a trusted certificate and an address only your own devices can open. Once, set it up: start Tailscale on the Mac, install it on the iPhone and sign in to the same account, and turn on **HTTPS Certificates** under DNS in the Tailscale admin console. Then:

```bash
./run.sh phone        # prints https://<this-mac>.<tailnet>.ts.net; ./run.sh phone off stops sharing
```

Open that address in Safari with the phone turned sideways. Prop it up so the front camera can see you, or press and hold the **Hold to talk** button. Speech and the LLM are still reached from the Mac.

For hot reload while changing the UI, use `./run.sh dev` and open http://localhost:5173. To use a different port, set `NATTER_PORT` (and update the proxy in `web/vite.config.ts`).

## Using it

| Do this | What happens |
|---|---|
| Raise a hand above your head and hold it (about 0.3 s) | The screen edge glows in your colour and numbers appear on the cards |
| Speak, then lower your hand | Your words appear in the caption bar; the cards involved are outlined, then change |
| Hold **Space** (or **Hold to talk** on a phone) | Same as raising a hand (for when you're alone, or the camera can't see you) |
| Press **/** | Type a command instead of speaking |
| “undo”, or ⌘Z | Reverses the last change, whoever made it |
| “cancel”, or **Esc** while talking | Abandons the command |
| “yes” / **Enter**, or “no” / **Esc** | Confirms or cancels a delete |
| Drag a card with the mouse | Moves it (also undoable) |

Things to try: “group the blue ones and call them water”, “put number four and the night market on the left”, “make the lemon grove bigger”, then “and make it red”, “star the sunset terrace”, “add a note saying book the train”, “arrange everything by colour”, “lay them out in a circle”, “spotlight the food ones”, “delete the stargazing card”.

If two people raise their hands, the second goes into a queue (shown top right) and gets the floor when the first finishes.

## Body Lab

The main way to use Natter: a bench for shaping a brainstorm with your hands: **http://127.0.0.1:8777/lab.html** (or http://localhost:5173/lab.html with `./run.sh dev`). Face the laptop as a mirror: your hands are drawn over a board of idea bubbles.

| Do this | What happens |
|---|---|
| Close a fist on a bubble | Picks it up; open your hand to drop it |
| Drop a bubble onto another | They merge, and the LLM names the combined idea |
| Let go while moving fast | Flings it off the board (with zones on, it slides to where you threw it) |
| While holding a bubble, a second fist anywhere | Pull apart or push together to resize it |
| Fist held closed on empty space for a moment, and say an idea | Holds a new idea (a ring fills first, so a missed grab doesn't become one). Open your hand to put it down; lowering your arm out of view puts it down too. Held for more than ten seconds it is let go, as talk and not an idea. If no words come back, a message says which microphone heard nothing. Set it down gently and it lands small; throw it down and it lands big; open your hand to place it. The LLM shortens what you said to a label |
| Point (index finger out) and rest the fingertip on a bubble for a moment, pull away, say an idea | Pulls a branch out of it; open your hand to plant it, or open it while still on the bubble to cancel |
| Pull a branch out and land it on another bubble, then open your hand | Connects the two with a dashed line (do it again to disconnect) |
| Victory sign ✌️ resting on a bubble | The LLM adds two ideas of its own as branches, marked with a dashed rim and a spark. Say an angle while the sign is up (“risks”, “cheaper”, “for kids”) and both ideas answer it; lower your hand to send. Say nothing and it works as before |
| Victory sign ✌️ resting on the knot in the middle of a connection | The same, for the pair: the LLM adds two ideas that come from both, hanging off the knot. “Similarities” gives two things they share, “differences” two ways they differ. The angle stays written on the line, and asking the same knot again gives two more |
| Close both fists on empty space at about the same time and push them together | Zooms out to the overview: the canvas is a grid of screen-sized areas, each shown small with a name from the LLM. Rest a pointing finger on an area to go in, or close both fists over it and pull them apart. An empty area is fresh space to continue in. **O**, a click, or the mouse wheel on empty space do the same |
| Raise both open hands above your head, say how to organise the board, lower them | The LLM labels axes or zones to match ("effort against impact", "now, later, never"), and the bubbles glide to where it judges they belong |
| Stretch a bubble large | It opens to show everything that was said, not just the short label (bubbles with more to show have three dots) |
| Hold a thumbs up / thumbs down on a bubble | Stars it / bins it |

Beside each hand is a short list of what it can do right now, which changes as the hand moves on and off bubbles (**H** hides it). A hand hanging at rest (wrist below the elbow) is drawn faintly and does nothing, so resting hands don't trigger gestures. Colour shows family: each new idea gets its own colour and its branches share it.

**?** shows every keyboard shortcut in a small card (a "? keys" reminder sits in the bottom right corner outside stage mode).

**N** says which kind the microphones are: auto, handheld or clip-on (also `lab.html?handheld` and `lab.html?clipon`; remembered). Handheld: a hand at the mouth is holding a microphone, so it starts nothing. Clip-on: a hand at the face is just a hand. Auto takes two microphones, or one input of an audio interface, to be handheld, and anything else to be clipped on. The readouts show which is in force.

**B** steps through the outlines drawn from the camera: body and hands, hands only, body only, neither (also `lab.html?outlines=none`; remembered). With the hands' outline off, the ring at each palm and its gesture sign stay. A fist holding a new idea is drawn as a ✊ in a glow, with a 🎙️ on it while it listens.

**Draw zones** switches to editing the zones. Close a fist at one corner, drag to the opposite corner and open your hand to finish a rectangle. Close a fist on a corner to resize, or on a border to move it. Point at a title until it says “Say its name”, speak the name, then open your hand. Names use the words heard directly; more than five words is taken as talk, and the zone keeps its old name (click the title to type a longer one). Hold a thumbs-down inside a zone to delete it (with the mouse: point at it and press Backspace); the bubbles in it stay where they are. Zones stay apart, and bubbles stay in place while you edit. **U** undoes drawing, moving, resizing, renaming or deleting. Click **Done drawing** to return to normal bubble gestures. With zones on, rewording and new suggestions use only the source bubble's zone; a bubble outside all zones uses only its own idea.

A bubble with two or more connections is a hub, and wears a small "✌️ all 4" badge. A victory sign on the hub itself asks about it and everything connected to it together (its lines and the connected bubbles light up while it asks), and the two new ideas branch from the hub. A sign on one of its knots still asks about just that pair.

**Tidy** on the side rail (**Y**, or "tidy up" said with both hands raised) lays the board out without changing any words: each connected group round its busiest bubble, what is joined to it in a ring and what grew from those fanning outward, with bubbles joined to nothing in a row along the bottom. Undo takes it back. Organising by voice no longer lets lines pull connected bubbles back together: a bubble sent to another zone stays there, its line stretching, until one end is picked up.

**P** (or `lab.html?stage`) is stage mode, for showing the lab to an audience: the readouts, the gesture guide, the hand hints and the Inputs button go. While a hand is in the middle of something, a few words beside it say what ("✊ Merge into …", the idea as it is heard). Once it is done, the same words go up in one large band at the top ("💡 New idea", "✊ Merged into …", "✌️ Ask for ideas"), which also says "✨ Thinking" while the words are on their way. A small dot bottom left says Ready, or what is down.

Hands are tracked best with only the two people holding microphones in shot, about 2 m from the camera, with nobody standing behind them and a light in front. Hold the microphone below the chin, not in front of the hand doing the gestures. With three or more hands in view the camera picture slows down and hands get lost.

**L** (or `lab.html?log`) shows the log panel in the bottom left corner, in stage mode too: the last six things heard and done, in plain words, with the time and how long the LLM took ("🎙️ Heard “Camera”", "✨ LLM → 📷 Camera · 1.0 s"). It is remembered.

**M** (or `lab.html?camera`) shows the camera picture, dimmed, behind the board, lined up with the hands drawn over it, so you can see what the camera sees (useful in low light). It is remembered.

Keys turn layers on and off over the same bubbles: **A** axes (easy to hard, small win to big win), **Z** zones (Keep, Try, Drop), **W** workbench. On the workbench a two-handed move rewrites the idea instead of resizing it: pull apart to take it further, push together for the simplest version, cross your hands over for the opposite. Each grows as a branch with words from the LLM. **-** and **=** zoom your body out and in on the board. Zoomed out, your hands only reach the middle of the screen, so a dashed frame shows the edge of reach and bubbles stay inside it; zoom in until the frame disappears to use the whole screen. **B** hides your body outline, and **[** and **]** make the bubbles smaller and bigger; both are remembered. **S** starts and stops listening for how to organise the board (the same as raising both hands). **U** undoes the last change (including a merge or a reorganisation), **C** clears the board, **R** loads a set of example ideas (the board starts empty), and **D** hides the readouts and the hint line.

Each session is logged to `lab-sessions/<start time>.jsonl`: what each hand was read as (and for how long), what the board did with it, the words heard and the words the LLM wrote, with timings. No audio or video is stored. Press **X** right after something fails and **G** after something works to mark those moments in the log.

Speech and the LLM come from the local server, so they need the microphone and an LLM: the local model, an API key or a Claude Code login. Without them the lab still works: new ideas get placeholder words and rewrites get a plain prefix.

**Two people, a microphone each.** Open **Inputs** and choose a **Second microphone**. An audio interface with two microphones plugged in is one device, so it is listed three times: by name, and as "input 1 only" and "input 2 only". Choose input 1 as the microphone and input 2 as the second. Two separate devices (two USB headsets) work the same way. The first microphone belongs to whoever stands on the left of the screen and the second to whoever stands on the right, so each person's words come only from their own microphone, and both can say an idea at the same moment. Each microphone has a line at the top left with a level bar and the input it listens to: talk into one and its bar moves. A second microphone that isn't on says so there. The readout (**D**) adds which microphone each hand speaks into. A hand that has been up at the mouth is taken to be holding a microphone and does nothing on the board, wherever it is held after that, until it opens flat. A two-handed move needs both hands from the same person. **K** swaps the microphones when the two people change sides. If an interface's inputs aren't listed on their own, open `lab.html?inputs`, which lists the first two inputs of every microphone. Organising the board by voice (**S**) listens on the first microphone.

**After a session.** Each session's camera picture and each microphone's sound are recorded on this computer, in `lab-recordings/` (**V** stops and starts it). For a transcript of everything that was said, with the time and the microphone for each line, run `uv run natter-transcript` in `server/`: it writes `lab-sessions/<session>.transcript.txt` for the newest session, using the running server's speech model. `scripts/replay.sh` runs a recording back through the hand tracking.

**Recording the screen too.** The camera recording shows the people, not the board. So the Lab records the page itself as well, bubbles, hands and all, and a session can be watched back as it looked. Chrome asks to share the tab every time the Lab is opened, on the first key or click: choose **Allow**. **Shift+V** turns screen recording off, and on again; the choice is remembered. The file goes in `lab-recordings/` beside the camera's, with `screen` in its name, at about 19 MB a minute.

**Watching a session back.** **http://127.0.0.1:8777/replay.html** shows a session's log beside its camera recording, with the microphones' sound. Playing the recording walks down the log; clicking a line, or anywhere on the timeline along the bottom, jumps the recording to that moment. **Moments** lists what was heard, what the LLM wrote and what was done, in plain words; **Everything** adds the rest of the log (grabs, hand sightings, keys). Clicking a line shows all the log holds for it. Lines where something went wrong (nothing heard, an idea dropped, an **X** mark) are red, and **F** goes to the next one. The newest recorded session opens first; choose another at the top left. Where the screen was recorded it is shown in place of the camera picture, and **C** switches between the two. Keys: **Space** play or pause, **↑ ↓** the line before or after, **← →** five seconds, **+ −** text size, **M** mirror, and **,** **.** to move the log 0.1 s if words and picture are out of step. It needs ffmpeg for sound and for jumping around; without it the picture still plays.

The code is in `web/src/lab/`: `body.ts` (hand smoothing), `play.ts` (what gestures do), `sense.ts` (camera and MediaPipe), `people.ts` (whose hand is whose), `main.ts` (drawing, speech and server). The words come from `server/src/natter_server/ideas.py`.

## How it fits together

```
Browser (web/)                                   Local server (server/, Python)
  camera → MediaPipe pose → who has a hand up
  FloorController: idle → armed → listening → resolving
  mic → 2 s pre-roll → audio for the turn  ── WebSocket ──►  Parakeet speech-to-text
                                                             grammar (undo, yes, cancel…)
  CommandBus ◄── validated action calls ◄───────────────────  LLM (Claude Haiku 4.5 → Sonnet 5.5, or local)
  board + captions + toasts
```

- The board's actions are in `web/src/scene/actions.ts`. Each one is a zod schema plus a pure function. The same schemas go to the LLM as tools, so adding an action there makes it speakable.
- `CommandBus` (`web/src/scene/bus.ts`) is the only thing that changes the board. It validates every call, rejects calls made against a board that changed meanwhile, keeps undo/redo, and holds deletes until someone confirms.
- The resolver (`server/src/natter_server/resolver.py`) tries the grammar first, then Haiku. It escalates to Sonnet when Haiku asks a clarifying question or proposes calls that fail validation.
- Every turn writes one line to `traces/YYYY-MM-DD.jsonl`: transcript, the models tried, their tool calls, the result and timings. No audio is stored.

## Privacy

Pose tracking runs in the page; video frames are never sent or stored. Audio is only captured while someone holds the floor (plus the 2 s pre-roll), transcribed on this Mac and then dropped. The transcript, a description of the board and the action list go to the Anthropic API.

## Tests

```bash
cd web && npm test              # bus, actions, floor controller, people tracking
cd server && uv run pytest -q   # grammar, validation, tier escalation, idea wording (no network)
cd server && uv run python evals/run.py   # 21 spoken commands against real Claude (needs the key)
```

`server/evals/board.json` is exported from the running app (`natter.sceneForModel()` and `natter.actions()` in the browser console). Regenerate it after changing the starting board or the actions.
