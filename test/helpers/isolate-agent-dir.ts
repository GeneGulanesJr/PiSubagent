// Point pi at an empty throwaway agent dir so tests never read the developer's
// real ~/.pi/agent config (pisubagent.tiers.json, pisubagent.limits.json, agents/).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pisubagent-test-agent-'));
