import { defineConfig } from 'vite';

// When built inside GitHub Actions for GitHub Pages, the site is served from
// https://<owner>.github.io/<repo>/ rather than the domain root, so asset
// references need the repo name prefixed. Locally and for the production
// sqltoerdiagram.com deployment, GITHUB_ACTIONS is unset and base stays '/'.
const base = process.env.GITHUB_ACTIONS
  ? `/${process.env.GITHUB_REPOSITORY.split('/')[1]}/`
  : '/';

export default defineConfig({
  base,
});
