import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'
for (const args of [[], ['--enable-privileged-webgl-extensions', '--enable-webgl-draft-extensions']]) {
  const browser = await chromium.launch({
    executablePath:
      '/Users/dempseypalmer/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', ...args],
  })
  const page = await browser.newPage()
  console.log(
    args.join(' ') || '(no flags)',
    await page.evaluate(
      () =>
        !!document
          .createElement('canvas')
          .getContext('webgl2')
          .getExtension('EXT_disjoint_timer_query_webgl2'),
    ),
  )
  await browser.close()
}
