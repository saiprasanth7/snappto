// SnappTo catalog — the same index as the Telegram bot (bot/catalog.py), so both
// products share one mental model:  Home → Passport Services | Tools (12 categories).
//
// where:
//   'device' → runs entirely on the phone, works offline
//   'online' → runs on the phone but needs internet (e.g. live currency rates)
//   'bot'    → needs server software; opens the Telegram bot with that tool
//   'soon'   → on the roadmap
export const BOT_USERNAME = 'Snappto_bot';
export const botLink = id => `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(id)}`;

const T = (id, label, desc, where, module) => ({ id, label, desc, where, module });

export const CATEGORIES = [
  { id: 'docs', emoji: '📄', title: 'Documents', tools: [
    T('merge', 'Merge PDFs', 'Combine several PDFs into one', 'device', 'pdf.js'),
    T('splitpdf', 'Split PDF', 'One file per page, or pick ranges', 'device', 'pdf.js'),
    T('pdfcompress', 'Compress PDF', 'Shrink scanned PDFs for upload limits', 'device', 'pdf.js'),
    T('img2pdf', 'Images → PDF', 'Turn photos into a single PDF', 'device', 'pdf.js'),
    T('rotate', 'Rotate PDF', 'Rotate all or selected pages', 'device', 'pdf.js'),
    T('extract', 'Extract pages', 'Keep only the pages you need', 'device', 'pdf.js'),
    T('delpages', 'Delete pages', 'Remove pages you don’t need', 'device', 'pdf.js'),
    T('pagenumbers', 'Add page numbers', 'Number every page', 'device', 'pdf.js'),
    T('watermark', 'Add watermark', 'Stamp text across every page', 'device', 'pdf.js'),
    T('pdftext', 'PDF → Text', 'Pull the text out of a PDF', 'device', 'pdf.js'),
    T('ocr', 'Scan → searchable text', 'Read text from scanned PDFs', 'device', 'ocr.js'),
    T('pdf2docx', 'PDF → Word', 'Editable .docx (via Telegram bot)', 'bot'),
    T('office2pdf', 'Word / PPT / Excel → PDF', 'Office files to PDF (via Telegram bot)', 'bot'),
    T('lock', 'Lock PDF', 'Add a password (via Telegram bot)', 'bot'),
    T('unlock', 'Unlock PDF', 'Remove a password you know (via Telegram bot)', 'bot'),
  ]},
  { id: 'img', emoji: '🖼', title: 'Images', tools: [
    T('removebg', 'Remove background', 'Cut out people — transparent PNG', 'device', 'image.js'),
    T('imgcompress', 'Compress image', 'Hit a size limit (e.g. under 200 KB)', 'device', 'image.js'),
    T('resize', 'Resize image', 'Exact pixels or percentage', 'device', 'image.js'),
    T('crop', 'Crop image', 'Free or fixed ratio crop', 'device', 'image.js'),
    T('imgrotate', 'Rotate / flip', 'Turn or mirror a photo', 'device', 'image.js'),
    T('convert_img', 'Convert format', 'JPG ⇄ PNG ⇄ WebP', 'device', 'image.js'),
    T('enhance', 'Enhance & sharpen', 'Upscale 2× and sharpen', 'device', 'image.js'),
    T('blurbg', 'Blur background', 'Portrait-mode style blur', 'device', 'image.js'),
    T('stripmeta', 'Remove photo metadata', 'Strip location & camera info', 'device', 'image.js'),
    T('imgocr', 'Extract text from image', 'Copy text out of a photo', 'device', 'ocr.js'),
    T('passportphoto', 'Passport photo maker', 'Compliant photo + print sheet', 'device', 'passport.js'),
    T('restore', 'AI restore old photo', 'Face restore + 4K (via Telegram bot)', 'bot'),
  ]},
  { id: 'sign', emoji: '🖋', title: 'Signature', tools: [
    T('signclean', 'Clean signature', 'Pure white background, crisp ink', 'device', 'signature.js'),
    T('signtransparent', 'Transparent signature', 'PNG to paste into documents', 'device', 'signature.js'),
    T('signexam', 'Signature for exam portals', 'Exact size & KB for SSC, UPSC, …', 'device', 'signature.js'),
    T('signcolor', 'Change ink colour', 'Make it blue or black', 'device', 'signature.js'),
  ]},
  { id: 'media', emoji: '🎬', title: 'Audio & Video', tools: [
    T('tomp3', 'Video → MP3', 'Extract audio (via Telegram bot)', 'bot'),
    T('vidcompress', 'Compress video', 'Smaller video (via Telegram bot)', 'bot'),
    T('trimvideo', 'Trim video', 'Cut start and end (via Telegram bot)', 'bot'),
    T('gif', 'Video → GIF', 'Short clip to GIF (via Telegram bot)', 'bot'),
    T('mutevideo', 'Remove audio', 'Silent video (via Telegram bot)', 'bot'),
    T('tts', 'Text → speech', 'Read text aloud', 'device', 'text.js'),
  ]},
  { id: 'curr', emoji: '💱', title: 'Money & Calculators', tools: [
    T('currency', 'Currency converter', 'Live rates, last rates offline', 'online', 'calc.js'),
    T('emi', 'EMI calculator', 'Monthly instalment & total interest', 'device', 'calc.js'),
    T('gst', 'GST calculator', 'Add or remove GST, CGST/SGST split', 'device', 'calc.js'),
    T('percentage', 'Percentage', 'X% of Y, % change', 'device', 'calc.js'),
    T('discount', 'Discount', 'Final price and savings', 'device', 'calc.js'),
    T('interest', 'Interest', 'Simple & compound interest', 'device', 'calc.js'),
    T('age', 'Age calculator', 'Exact age from date of birth', 'device', 'calc.js'),
    T('datediff', 'Date difference', 'Days, weeks, months between dates', 'device', 'calc.js'),
    T('tip', 'Tip & bill split', 'Split a bill fairly', 'device', 'calc.js'),
    T('convert', 'Unit converter', 'Length, weight, temperature, data…', 'device', 'calc.js'),
  ]},
  { id: 'ai', emoji: '✨', title: 'AI Tools', tools: [
    T('ask', 'Ask AI', 'Any question (via Telegram bot)', 'bot'),
    T('summarize', 'Summarise text', 'Short summary (via Telegram bot)', 'bot'),
    T('rewrite', 'Rewrite text', 'Clearer & professional (via Telegram bot)', 'bot'),
    T('grammar', 'Fix grammar', 'Spelling & grammar (via Telegram bot)', 'bot'),
    T('email', 'Draft an email', 'From a short brief (via Telegram bot)', 'bot'),
    T('letter', 'Formal letter', 'Applications & complaints (via Telegram bot)', 'bot'),
  ]},
  { id: 'lang', emoji: '🌐', title: 'Language', tools: [
    T('translate', 'Translate text', 'Any language (via Telegram bot)', 'bot'),
    T('imgocr_lang', 'Read Hindi / Telugu text', 'Text from photos in Indian scripts', 'device', 'ocr.js'),
    T('tts_lang', 'Pronounce text', 'Hear it spoken', 'device', 'text.js'),
  ]},
  { id: 'qr', emoji: '🔳', title: 'QR & Barcode', tools: [
    T('qrscan', 'Scan QR / barcode', 'Camera or image — shows link safely', 'device', 'qr.js'),
    T('qrtext', 'QR from text / link', 'Any text or URL', 'device', 'qr.js'),
    T('qrupi', 'UPI payment QR', 'Get paid to your UPI ID', 'device', 'qr.js'),
    T('qrwifi', 'Wi-Fi QR', 'Guests join without typing', 'device', 'qr.js'),
    T('qrcontact', 'Contact QR', 'Share your contact card', 'device', 'qr.js'),
    T('barcode', 'Barcode generator', 'Code 128, EAN-13, UPC…', 'device', 'qr.js'),
  ]},
  { id: 'text', emoji: '🔤', title: 'Text', tools: [
    T('wordcount', 'Word & character count', 'Words, characters, reading time', 'device', 'text.js'),
    T('changecase', 'Change case', 'UPPER, lower, Title, Sentence', 'device', 'text.js'),
    T('cleanup', 'Clean up text', 'Extra spaces, blank & duplicate lines', 'device', 'text.js'),
    T('sortlines', 'Sort lines', 'A→Z, Z→A, numeric, shuffle', 'device', 'text.js'),
    T('findreplace', 'Find & replace', 'Plain text or regex', 'device', 'text.js'),
    T('extractinfo', 'Extract emails / phones / links', 'Pull contacts out of text', 'device', 'text.js'),
    T('compare', 'Compare two texts', 'See what changed', 'device', 'text.js'),
    T('jsonformat', 'Format JSON', 'Pretty-print & validate', 'device', 'text.js'),
    T('text2pdf', 'Text → PDF', 'Save notes as a PDF', 'device', 'text.js'),
  ]},
  { id: 'file', emoji: '🗂', title: 'Files', tools: [
    T('zip', 'Create ZIP', 'Bundle files into one .zip', 'device', 'file.js'),
    T('unzip', 'Open ZIP', 'Extract and save files', 'device', 'file.js'),
    T('filehash', 'File checksum', 'MD5 / SHA-256 to verify downloads', 'device', 'file.js'),
    T('filetype', 'What is this file?', 'Detect the real file type', 'device', 'file.js'),
  ]},
  { id: 'career', emoji: '🎓', title: 'Student & Career', tools: [
    T('examphoto', 'Exam photo & signature', 'SSC, UPSC, NEET, JEE specs', 'device', 'passport.js'),
    T('signexam2', 'Exam signature resizer', 'Exact KB & pixels', 'device', 'signature.js'),
    T('resume', 'Resume draft', 'From your details (via Telegram bot)', 'bot'),
    T('sop', 'SOP writer', 'Statement of purpose (via Telegram bot)', 'bot'),
  ]},
  { id: 'util', emoji: '🧰', title: 'Everyday', tools: [
    T('password', 'Password generator', 'Strong, random, private', 'device', 'text.js'),
    T('randnum', 'Random number / pick', 'Dice, coin, pick from a list', 'device', 'text.js'),
    T('checklist', 'Checklist', 'Quick saved lists', 'device', 'text.js'),
    T('billsplit', 'Bill splitter', 'Who owes what', 'device', 'calc.js'),
  ]},
];

// Passport services — same grouping as the bot. `pp_photo` opens the photo tool,
// every other id opens a guidance page (js/guidance.js).
export const PASSPORT = [
  { title: 'Application', items: [
    ['pp_photo', '🪪', 'Passport photo', 'Compliant photo + print sheet'],
    ['new_passport', '🆕', 'Apply for a new passport', 'Steps, documents, fees'],
    ['renew', '🔄', 'Renew or reissue', 'Expired, pages full, changes'],
    ['tatkaal', '⚡', 'Emergency / Tatkaal', 'Faster processing'],
    ['minor', '🧒', 'Passport for a minor', 'Consent & documents'],
    ['senior', '🧓', 'Senior citizens', 'Concessions & help'],
  ]},
  { title: 'Tracking & appointments', items: [
    ['track', '📦', 'Track application', 'Status & delivery'],
    ['police', '👮', 'Police verification', 'Pre, post & delays'],
    ['appointment', '📅', 'Appointment', 'Book, reschedule, carry'],
    ['locator', '📍', 'Passport office locator', 'PSK, POPSK, RPO'],
  ]},
  { title: 'Documents, fees & forms', items: [
    ['documents', '📑', 'Required documents', 'What to bring'],
    ['fees', '💰', 'Fees', 'By booklet & scheme'],
    ['forms', '📝', 'Forms & annexures', 'Affidavits & declarations'],
  ]},
  { title: 'Corrections & special cases', items: [
    ['corrections', '✏️', 'Update passport details', 'Name, address, DOB'],
    ['lost', '🚨', 'Lost or stolen', 'FIR & reissue'],
    ['damaged', '💥', 'Damaged passport', 'Reissue steps'],
    ['overseas', '🌍', 'Overseas / NRI', 'Embassy & consulate'],
    ['complaints', '📣', 'Complaints & support', 'Grievances & helpline'],
    ['faqs', '❓', 'Passport FAQs', 'Quick answers'],
    ['links', '🔗', 'Official links', 'Verified portals only'],
  ]},
];

export const TOOLS = CATEGORIES.flatMap(c => c.tools.map(t => ({ ...t, cat: c.id, catTitle: c.title, emoji: c.emoji })));
export const TOOL = Object.fromEntries(TOOLS.map(t => [t.id, t]));
export const CAT = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));
export const PASSPORT_ITEMS = PASSPORT.flatMap(s => s.items.map(([id, e, t, d]) => ({ id, emoji: e, title: t, desc: d })));

const SYN = {
  'compress pdf': 'pdfcompress', 'pdf to word': 'pdf2docx', 'merge': 'merge', 'combine pdf': 'merge',
  'split': 'splitpdf', 'background': 'removebg', 'remove bg': 'removebg', 'passport': 'passportphoto',
  'photo': 'passportphoto', 'qr': 'qrscan', 'scan': 'qrscan', 'upi': 'qrupi', 'wifi': 'qrwifi',
  'emi': 'emi', 'loan': 'emi', 'gst': 'gst', 'tax': 'gst', 'age': 'age', 'currency': 'currency',
  'usd': 'currency', 'inr': 'currency', 'dollar': 'currency', 'ocr': 'imgocr', 'text from': 'imgocr',
  'signature': 'signclean', 'sign': 'signclean', 'resize': 'resize', 'kb': 'imgcompress',
  'compress image': 'imgcompress', 'zip': 'zip', 'password': 'password', 'word count': 'wordcount',
};

/** Ranked search across tools and passport services. */
export function search(q) {
  q = (q || '').toLowerCase().trim();
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const scored = [];
  const syn = Object.entries(SYN).filter(([k]) => q.includes(k)).map(([, v]) => v);
  for (const t of TOOLS) {
    const hay = `${t.label} ${t.desc} ${t.catTitle}`.toLowerCase();
    let s = 0;
    if (t.label.toLowerCase().startsWith(q)) s += 6;
    if (hay.includes(q)) s += 4;
    const hits = words.filter(w => hay.includes(w)).length;
    s += hits + (words.length > 1 && hits === words.length ? 4 : 0);
    if (syn.includes(t.id)) s += 3;
    if (s > 0 && t.where === 'device') s += 0.5;
    if (s > 0) scored.push({ kind: 'tool', item: t, s });
  }
  for (const p of PASSPORT_ITEMS) {
    const hay = `${p.title} ${p.desc} passport`.toLowerCase();
    const hits = words.filter(w => hay.includes(w)).length;
    let s = (hay.includes(q) ? 4 : 0) + hits + (words.length > 1 && hits === words.length ? 4 : 0);
    if (s > 0) scored.push({ kind: 'passport', item: p, s: s - 0.5 });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, 20);
}

export const QUICK = ['passportphoto', 'pdfcompress', 'removebg', 'qrscan', 'emi', 'imgocr', 'merge', 'imgcompress'];
