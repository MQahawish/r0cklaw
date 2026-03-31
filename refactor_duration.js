const fs = require('fs');
const glob = require('glob');
const path = require('path');

const filesToProcess = [
  'convex/rocklaw/worldRefreshNode.ts',
  ...glob.sync('agents/*/workspace/skills/*/SKILL.md'),
  ...glob.sync('agents/*/seed_skills/*/SKILL.md'),
  'agents/shared/seed_docs/TOOLS.md',
  ...glob.sync('agents/*/seed_docs/AGENTS.md')
];

for (const file of filesToProcess) {
  const filePath = path.resolve(__dirname, file);
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    let original = content;
    // Replace ,"duration_ticks":1
    content = content.replace(/,"duration_ticks":1/g, '');
    // Replace "duration_ticks":1,
    content = content.replace(/"duration_ticks":1,/g, '');
    // Also replace `,"duration_ticks":1\}` with `\}` where escaped in regex inside ts files
    content = content.replace(/,"duration_ticks":1\\\}/g, '\\}');
    if (content !== original) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`Updated ${file}`);
    }
  }
}
