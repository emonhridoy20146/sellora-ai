# Audio fixtures

Short sine-tone recordings (no speech) made with ffmpeg, used by the voice note tests and
the stand-ins:

| File           | Format                                        | Length |
| -------------- | --------------------------------------------- | ------ |
| `voice-4s.ogg` | Ogg Opus, mono 16 kHz (what WhatsApp records) | 4.2 s  |
| `voice-2s.m4a` | MP4 / AAC (what Messenger and Instagram send) | 2.5 s  |
| `voice-1s.mp3` | MP3                                           | 1.5 s  |

```sh
ffmpeg -f lavfi -i "sine=frequency=440:duration=4.2" -ac 1 -ar 16000 -c:a libopus -b:a 16k voice-4s.ogg
ffmpeg -f lavfi -i "sine=frequency=330:duration=2.5" -ac 1 -c:a aac -b:a 32k voice-2s.m4a
ffmpeg -f lavfi -i "sine=frequency=330:duration=1.5" -ac 1 -c:a libmp3lame -b:a 32k voice-1s.mp3
```
