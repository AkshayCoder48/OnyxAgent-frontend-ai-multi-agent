## Description: <br>
Ultimate AI agent memory system for Cursor, Claude, ChatGPT & Copilot. WAL protocol + vector search + git-notes + cloud backup. Never lose context again. Vibe-coding ready. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[nextfrontierbuilds](https://clawhub.ai/user/nextfrontierbuilds) <br>

### License/Terms of Use: <br>
MIT <br>


## Use Case: <br>
Developers and AI-agent users use this skill to set up persistent project memory, including session state, curated Markdown archives, vector recall, Git-notes decisions, and optional cloud memory integrations. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: Persistent memory can capture sensitive prompts, code, business context, or personal details. <br>
Mitigation: Require explicit approval before saving sensitive information, minimize what is stored, and periodically review memory files and vector entries. <br>
Risk: Optional Mem0 and SuperMemory integrations may upload or retain conversation-derived facts with third-party services. <br>
Mitigation: Enable those integrations only after reviewing data-handling terms and confirming that the intended content may be sent to those services. <br>
Risk: The documented cleanup command deletes the local LanceDB vector store. <br>
Mitigation: Back up memory data and confirm deletion intent before running destructive cleanup commands. <br>


## Reference(s): <br>
- [ClawHub skill page](https://clawhub.ai/nextfrontierbuilds/skills/elite-longterm-memory) <br>
- [README.md](README.md) <br>
- [SKILL.md](SKILL.md) <br>
- [npm package](https://www.npmjs.com/package/elite-longterm-memory) <br>


## Skill Output: <br>
**Output Type(s):** [Markdown, Code, Shell commands, Configuration, Guidance, Files] <br>
**Output Format:** [Markdown guidance with shell commands, JSON configuration snippets, JavaScript examples, and generated memory files] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Requires OPENAI_API_KEY for OpenAI-backed memory search; optional Mem0 and SuperMemory integrations use their own API keys.] <br>

## Skill Version(s): <br>
1.2.3 (source: SKILL.md frontmatter, package.json, server release evidence) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
