## Description: <br>
Extract frames or short clips from videos using ffmpeg. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[steipete](https://clawhub.ai/user/steipete) <br>

### License/Terms of Use: <br>


## Use Case: <br>
Developers, reviewers, and other agent users use this skill to extract a first frame, timestamped frame, indexed frame, or quick thumbnail from a local video for inspection and sharing. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: The skill runs ffmpeg on local video files selected by the user and writes extracted image frames locally. <br>
Mitigation: Use trusted input videos, choose an output directory appropriate for the video's sensitivity, and review the output path before running the command. <br>
Risk: The frame extraction script passes overwrite behavior to ffmpeg for the requested output path. <br>
Mitigation: Use a new or disposable output filename, or confirm that replacing an existing frame file is acceptable before execution. <br>


## Reference(s): <br>
- [FFmpeg](https://ffmpeg.org) <br>
- [ClawHub Skill Page](https://clawhub.ai/steipete/skills/video-frames) <br>


## Skill Output: <br>
**Output Type(s):** [shell commands, files, guidance] <br>
**Output Format:** [Markdown guidance with shell commands; the script outputs the local frame file path as text.] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Produces a local image frame file, typically JPEG or PNG, using ffmpeg.] <br>

## Skill Version(s): <br>
1.0.0 (source: server release metadata) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
