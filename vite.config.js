import { execSync } from 'node:child_process';

// serves the CURRENT commit per request — cannot go stale, unlike a baked-in hash
export default {
  plugins: [{
    name: 'build-info',
    configureServer(server) {
      server.middlewares.use('/__build', (req, res) => {
        let info;
        try {
          info = {
            commit: execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(),
            subject: execSync('git log -1 --format=%s', { encoding: 'utf8' }).trim().slice(0, 60),
            dirty: execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0,
          };
        } catch { info = { commit: 'no-git', subject: '', dirty: false }; }
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(info));
      });
    },
  }],
};
