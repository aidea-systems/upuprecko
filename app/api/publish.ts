// Vercel function: POST /api/publish, header X-Refresh-Token, body { doc, baseSavedAt }.
// Commits the ownership document to app/data/ownership.json on main. All logic is in server/publish.ts.
import { createPublishHandler } from '../server/publish.js';

export const config = { maxDuration: 30 };

export default createPublishHandler(() => ({
  refreshToken: process.env.REFRESH_TOKEN,
  githubToken: process.env.GITHUB_TOKEN,
  githubRepo: process.env.GITHUB_REPO,
}));
