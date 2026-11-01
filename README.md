# SnappTo

Everyday document and photo tools that run entirely on your phone, even with no network.

**Open it:** https://saiprasanth7.github.io/snappto/

- 🪪 Passport and visa photos in the exact official size, with a printable sheet
- 📄 PDF: merge, split, compress, rotate, page numbers, watermark, text, OCR
- 🖼 Photos: remove or blur background, compress, resize, crop, exam signatures
- 💱 EMI, GST, currency, unit converters · 🔳 QR codes · ✍️ text tools · 🗂 ZIP and hashes

Files never leave the device. Install it from the browser menu (iPhone: Share ▸ Add to Home Screen)
and it keeps working offline. Tools that need a server (PDF → Word, video, AI) open the
[@Snappto_bot](https://t.me/Snappto_bot) Telegram bot.

## Development

Static site, no build step. After changing any file, regenerate the service worker so
installed copies pick up the change:

```bash
node scripts/build-sw.mjs
```

Tool modules follow [CONTRACT.md](CONTRACT.md). Third-party licences are in `vendor/LICENSES/`
and next to each vendored library.
