// Runs the project's Karma config in a headless Chrome that cannot reach the internet
import base from '../karma.conf.js';

export default function (config) {
  base(config);
  config.set({
    basePath: new URL('..', import.meta.url).pathname,
    browsers: ['ChromeOffline'],
    customLaunchers: {
      ChromeOffline: {
        base: 'ChromeHeadless',
        flags: [
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-sync',
          '--disable-domain-reliability',
          '--disable-client-side-phishing-detection',
          '--no-pings',
          '--metrics-recording-only',
          // Anything not on this machine goes to a dead proxy
          '--proxy-server=http://127.0.0.1:9',
          '--proxy-bypass-list=localhost;127.0.0.1',
        ],
      },
    },
    reporters: ['progress'],
    singleRun: true,
    restartOnFileChange: false,
  });
}
