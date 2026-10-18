# Bundled skill repositories + MCP-Market configs

The default skill repositories ship AS LOCAL FILES in this app (user request
2026-10-18: *"Don't add them as repo links — add them as files, downloaded
directly"*). Browsing and installing never touches the GitHub API, jsDelivr or
any rate-limited service — everything below is served same-origin by the app
itself.

## Layout

```
public/skill-repos/
  <repo-id>/manifest.json     # skill index: name, description, dir, files[]
  <repo-id>/skills/<dir>/…    # the actual skill files (SKILL.md + supporting)

public/mcp-market/index.json  # 10 MCPMarket servers with REAL connection
                              # configs (remote URLs / stdio commands / env /
                              # tool lists), extracted from each server's
                              # marketplace page + GitHub README
```

## Repositories

| id | source | skills | notes |
|----|--------|--------|-------|
| `ecc` | github.com/affaan-m/ecc | 4 | remotion-video-creation, make-interfaces-feel-better, frontend-slides, liquid-glass-design (the four user-requested skills, via `npx skillfish add affaan-m/ecc …`) |
| `api-anything` | github.com/goodnight000/api-anything | 1 | SKILL.md + the `sites/*.md|json` service-reference docs (exact service/action identifiers) |
| `silk-design` | github.com/bendrape1-byte/silk-design | 1 | whole repo is one skill (templates/references included) |
| `everything-ai` | github.com/mitunmanav/everything-ai | 1 | end-to-end autonomous task ownership |
| `addhumanity` | github.com/olivierlesnicki/addhumanity | 10 | human-support companion skills |
| `threejs-game-skills` | github.com/majidmanzarpour/threejs-game-skills | 9 | game production pipeline |
| `mengto-skills` | github.com/MengTo/Skills (agent-skills/) | 177 | **partial** — SKILL.md bodies bundled; supporting files live-fetch on install |
| `uploaded-skills` | the user's `upload/Skills.zip` | 21 | zip-of-zips, extracted per skill |

## Runtime

`src/lib/skills/repo-browser.ts` reads these files first (transport 0);
jsDelivr → codeload remain as live fallbacks for anything not bundled.
`src/lib/tools/mcp_management.ts` (action `market`) serves the bundled MCP
configs; the static `MCP_MARKET_SERVERS` registry is the offline fallback.

## Regenerating

```
# 1. clone the sources (token may be needed for rate limits)
git clone --depth 1 https://github.com/affaan-m/ecc.git            /tmp/skill-dl/ecc
git clone --depth 1 https://github.com/bendrape1-byte/silk-design  /tmp/skill-dl/bendrape1-byte_silk-design
git clone --depth 1 https://github.com/olivierlesnicki/addhumanity /tmp/skill-dl/olivierlesnicki_addhumanity
git clone --depth 1 https://github.com/majidmanzarpour/threejs-game-skills /tmp/skill-dl/majidmanzarpour_threejs-game-skills
git clone --depth 1 https://github.com/MengTo/Skills                /tmp/skill-dl/MengTo_Skills
git clone --depth 1 https://github.com/goodnight000/api-anything   /tmp/skill-dl/goodnight000_api-anything
git clone --depth 1 https://github.com/mitunmanav/everything-ai     /tmp/skill-dl/mitunmanav_everything-ai
unzip upload/Skills.zip -d /tmp/skill-dl/Skills.zip_x               # zip-of-zips
# 2. fetch the MCPMarket pages (chrome-devtools tools are parsed from them)
mkdir -p /tmp/skill-dl/mcpmarket && cd /tmp/skill-dl/mcpmarket
for s in chrome-devtools-1 serena 2ools superpowers tubealfred-youtube chatgpt-redis youtube-search-download pdf-generator-1 free-proxy-list site-shot; do
  curl -sL "https://mcpmarket.com/server/$s" -o "$s.html"
done
# 3. bundle
python3 scripts/bundle_skill_repos.py --source /tmp/skill-dl
```
