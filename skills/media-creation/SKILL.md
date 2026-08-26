---
name: media-creation
description: Produce images, speech, diagrams and video edits — pictures and voiceovers generated through the owner's configured provider, everything else edited deterministically with ffmpeg, ImageMagick and Graphviz — and inspect the result before delivering it. Use when the deliverable is a picture, an illustration, a diagram, an audio clip, a voiceover, a video edit or a screen recording. Do not use to run any model locally, do not use to generate a video from a prompt because there is no route to one, and do not use for charts derived from data, which belong to data-analysis.
license: AGPL-3.0-or-later
compatibility: Every deterministic tool named here is installed on this computer by athanor - ffmpeg, ImageMagick as `magick`, and Graphviz. Generated images and speech go through the owner's configured provider; there is no generated video here at all.
allowed-tools: generate_media image_read audio_read shell file_read file_write files_list publish_artifact
metadata:
  athanor.tier: 'builtin'
  athanor.version: '2.2.0'
  athanor.risk: 'workspace'
  athanor.domain: 'media'
---

# Media creation

Two very different paths. Choose deliberately: generation is probabilistic and costs money;
transformation is deterministic and free.

## Deterministic first

If the task is crop, resize, convert, trim, transcode, concatenate, subtitle, composite, or draw a
diagram from a specification, do not generate anything.

**Images — ImageMagick.**

```
magick in.png -resize 1200x -quality 88 out.jpg          # width-constrained, aspect preserved
magick in.png -gravity center -crop 1:1 +repage out.png  # square crop from the centre
magick in.png -strip out.png                             # drop EXIF, including GPS
magick identify -format '%wx%h %m %b\n' out.jpg          # read back what was actually written
```

Always `-strip` before anything leaves the workspace: camera images carry location and device
metadata. Use `-resize 1200x` (width only) so aspect ratio is preserved; `1200x1200!` distorts.

To turn a PDF page into an image use `pdftoppm -png -r 200 -f 1 -l 1 in.pdf page`, not ImageMagick:
the distribution ships a policy file that disables ImageMagick's PDF coder, so `magick in.pdf` comes
back with a security-policy error rather than an image.

**Diagrams — Graphviz or Mermaid**, not a generated picture. A generated "architecture diagram" has
invented boxes and misspelled labels.

```
dot -Tsvg -o arch.svg arch.dot
dot -Tpng -Gdpi=150 -o arch.png arch.dot
```

Keep the source file next to the output so the diagram can be edited later. Check every label
against the thing it names.

**Audio and video — ffmpeg.**

```
ffmpeg -i in.mp4 -ss 00:01:30 -to 00:02:15 -c copy clip.mp4     # lossless cut on keyframes
ffmpeg -i in.mp4 -vf scale=-2:720 -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k out.mp4
ffmpeg -i in.wav -af loudnorm=I=-16:TP=-1.5:LRA=11 out.wav      # broadcast-ish loudness
ffmpeg -i in.mp4 -vf "subtitles=subs.srt" -c:a copy subbed.mp4
ffmpeg -i in.mp4 -ss 00:00:05 -frames:v 1 thumb.png
```

`-c copy` cuts only at keyframes, so the start may drift by up to a few seconds; re-encode when the
cut must be exact. `scale=-2:720` keeps width even, which H.264 requires. Always read ffmpeg's
final summary line — it reports the real duration and stream layout, and a "successful" command
that produced a 0-second file is common when the input mapping was wrong.

## Hosted generation

Two kinds, and only two: a still image, and speech. There is no video generation on this computer —
the provider has no zero-retention route to one and `generate_media` refuses it — so a request for a generated clip is answered by saying that plainly and offering what
can actually be done: stills, a Graphviz diagram, or an ffmpeg edit of footage the owner already
has. No model weights run on this machine and nothing is downloaded to run locally.

1. **Write the prompt as a specification.** Subject, composition and framing, style, lighting,
   colour, aspect ratio, and what must not appear. "A wide, eye-level product photo of a matte
   black kettle on a light grey seamless background, soft diffused lighting from the left, no text,
   no hands" beats "a nice kettle photo". Text rendered inside generated images is unreliable —
   compose text over the image afterwards with ImageMagick instead.
2. **`generate_media`.** It picks the reviewed model for the kind you asked for. The cost is
   priced from the request itself rather than from anything you pass, and it is checked against the
   owner's spending limit before the provider is called; once a task has spent about a quarter of a dollar on media, every further generation
   stops for their approval. Say what a generation will cost before starting a batch of them. It
   returns when the file exists, so there is nothing to wait for and nothing to poll.
3. **`image_read` the result.** Always. Check it matches the brief: correct subject, correct count
   of objects, no distorted hands or faces, no garbled text, correct aspect ratio, no watermark.
4. **Iterate on the prompt, not the seed.** Change one attribute at a time so you learn what moved
   the output. Keep the seed fixed while iterating on wording, then vary the seed for alternatives.
   Set a hard limit — usually three attempts — then show the owner what you have and ask.

Speech: the prompt is the script, word for word, and it is what the provider bills for. State the
voice, pace and any pronunciation guidance in the surrounding request. Then **listen back with
`audio_read`**: it transcribes the generated `.mp3` and returns what was actually said, which is the
only way to catch a mispronounced name, a dropped clause or a number read as digits. Compare that
transcript to the script word for word. `audio_read` is billed by the minute of recording, so one
call covers a whole voiceover; a reading is bounded at ninety minutes and resumes by second rather
than failing on a long file.

## Verification

- Every image is inspected with `image_read` against the brief before delivery.
- Every generated voiceover is transcribed with `audio_read` and the transcript compared to the
  script; a clip nobody listened to is not a delivered clip.
- Every edited video: check duration, resolution and audio presence with
  `ffprobe -hide_banner in.mp4`, and extract two frames to look at.
- Every diagram: read every label and confirm it against the source of truth.
- File sizes are sane for the medium; a 40 MB PNG or a 200 KB "video" is a defect.
- Publish with `publish_artifact` and attach a preview.

## Failure modes

- **Generating what could have been computed.** Diagrams, charts and text overlays should be drawn,
  not imagined.
- **Skipping the catalog** and passing a model id that does not exist, which is refused outright.
- **Promising a generated video.** There is no route to one; say so at the point it is asked for
  rather than after a failed call.
- **Not looking at the output.** Generation returns success for an image that is nothing like the
  brief.
- **Aspect-ratio distortion** from `!` in an ImageMagick geometry, or from an odd width in H.264.
- **Metadata leakage.** Unstripped EXIF has published home addresses.
- **Endless re-rolling.** Three attempts, then ask. Each one costs the owner money.
