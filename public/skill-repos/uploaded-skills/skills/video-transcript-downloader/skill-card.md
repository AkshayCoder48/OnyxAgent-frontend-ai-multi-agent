## Description: <br>
Download videos, audio, subtitles, and clean paragraph-style transcripts from YouTube and any other yt-dlp supported site. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[steipete](https://clawhub.ai/user/steipete) <br>

### License/Terms of Use: <br>


## Use Case: <br>
Developers and agent users use this skill to retrieve transcripts, subtitles, audio, video files, and format listings from supported video sites when they need local media assets or readable transcript text. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: The skill can run yt-dlp and ffmpeg and save remote media locally. <br>
Mitigation: Review commands before execution and choose output directories deliberately. <br>
Risk: Unrestricted extra yt-dlp arguments after -- can enable powerful or unsafe yt-dlp behavior. <br>
Mitigation: Do not allow untrusted page content, prompts, or copied text to supply extra yt-dlp arguments, especially options that execute commands or change output paths. <br>


## Reference(s): <br>
- [ClawHub skill page](https://clawhub.ai/steipete/skills/video-transcript-downloader) <br>
- [Publisher profile](https://clawhub.ai/user/steipete) <br>
- [youtube-transcript-plus npm package](https://registry.npmjs.org/youtube-transcript-plus/-/youtube-transcript-plus-1.1.1.tgz) <br>


## Skill Output: <br>
**Output Type(s):** [text, markdown, code, shell commands, configuration, guidance] <br>
**Output Format:** [Markdown guidance with inline shell commands and command output paths or transcript text] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [May produce local media, subtitle, or audio files through yt-dlp and ffmpeg.] <br>

## Skill Version(s): <br>
1.0.0 (source: package.json and server release evidence) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
