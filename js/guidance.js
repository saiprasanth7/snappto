// Passport guidance (India). SnappTo is a guidance assistant: it explains and
// links to OFFICIAL sources, and never claims to approve, speed up or submit.
export const PORTAL = 'https://www.passportindia.gov.in';
const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text} ↗</a>`;

// No prototype, so a URL like #/guide/constructor finds nothing.
export const GUIDES = Object.assign(Object.create(null), {
  new_passport: { title: 'Apply for a new passport', body: `
    <p><b>Steps (Passport Seva)</b></p>
    <ol><li>Register / log in on the official portal</li>
    <li>Fill the <b>Fresh Passport</b> form, pay the fee, book an appointment</li>
    <li>Visit the PSK / POPSK with originals and self-attested copies</li>
    <li>Police verification (usually after the visit)</li></ol>
    <p><b>Typical documents:</b> proof of address, proof of date of birth, identity proof.</p>
    <p>${link(PORTAL, 'Apply on passportindia.gov.in')}</p>` },
  renew: { title: 'Renew or reissue', body: `
    <p>Use <b>Re-issue</b> when your passport is expired or expiring, the pages are full, or your name, address or appearance changed — and for damaged or lost passports.</p>
    <p>You can apply up to <b>one year before</b> expiry, or after it. Bring the old passport.</p>
    <p>${link(PORTAL, 'Apply for re-issue')}</p>` },
  tatkaal: { title: 'Emergency / Tatkaal', body: `
    <p>Tatkaal is a <b>faster scheme</b> for urgent needs, at a higher fee and with its own eligibility and verification rules. Not every applicant qualifies.</p>
    <p>Check the current Tatkaal fee, documents and eligibility on the portal before booking.</p>
    <p>${link(PORTAL, 'Tatkaal details')}</p>` },
  minor: { title: 'Passport for a minor', body: `
    <p>Usually needs both parents’ details, <b>parental consent</b> (the applicable annexure), and the child’s proof of date of birth. Copies of the parents’ passports help.</p>
    <p>Use the <b>Passport photo</b> tool for a compliant photo of the child.</p>
    <p>${link(PORTAL, 'Minor passport information')}</p>` },
  senior: { title: 'Senior citizens', body: `
    <p>Senior citizens may be eligible for <b>fee concessions</b> and appointment assistance in some cases. Carry proof of age.</p>
    <p>${link(PORTAL, 'Details')}</p>` },
  track: { title: 'Track your application', body: `
    <p>Track with your <b>file number</b> and date of birth on the official status page. Delivery is by India Post Speed Post, which you can also track.</p>
    <p>${link(PORTAL + '/Online/index', 'Track application status')}</p>` },
  police: { title: 'Police verification', body: `
    <p>Verification can be <b>pre</b>, <b>post</b> or <b>not required</b>, depending on your case. Keep originals of your address and identity proofs ready for the officer.</p>
    <p>If it’s delayed, follow up at your local police station or the PSK.</p>
    <p>${link(PORTAL, 'More information')}</p>` },
  appointment: { title: 'Appointment', body: `
    <p>Appointments are booked <b>after paying the fee</b> online. You can reschedule or cancel within the allowed limit.</p>
    <p>Bring the appointment receipt plus all originals and copies.</p>
    <p>${link(PORTAL + '/Online/index', 'Book or manage an appointment')}</p>` },
  locator: { title: 'Passport office locator', body: `
    <p>Find your nearest <b>Passport Seva Kendra (PSK)</b>, <b>Post Office PSK (POPSK)</b> or <b>Regional Passport Office</b>, with timings, on the official locator.</p>
    <p>${link(PORTAL + '/Online/index', 'Locate a centre')}</p>` },
  documents: { title: 'Required documents', body: `
    <p>It depends on the service. Commonly:</p>
    <ul><li><b>Proof of address</b> — Aadhaar, utility bill, bank passbook…</li>
    <li><b>Proof of date of birth</b> — birth certificate, Aadhaar, Class 10 marksheet…</li>
    <li><b>Identity proof</b></li></ul>
    <p>The portal’s <b>Document Advisor</b> lists the exact set for your case.</p>
    <p>${link(PORTAL, 'Document Advisor')}</p>` },
  fees: { title: 'Fees', body: `
    <p>The fee depends on the <b>booklet</b> (36 or 60 pages), the applicant’s age, and <b>normal vs Tatkaal</b>. Confirm the exact amount on the portal’s fee calculator when you pay.</p>
    <p>${link(PORTAL, 'Official fee calculator')}</p>` },
  forms: { title: 'Forms & annexures', body: `
    <p>Application forms and annexures (consent, affidavits, declarations) are in the official <b>Forms &amp; Affidavits</b> section.</p>
    <p>${link(PORTAL, 'Forms & affidavits')}</p>` },
  corrections: { title: 'Update passport details', body: `
    <p>Changes to name, address, date of birth, spouse name, place of birth or signature are made through <b>Re-issue</b>, with proof of the change.</p>
    <p>${link(PORTAL, 'Apply for a correction')}</p>` },
  lost: { title: 'Lost or stolen passport', body: `
    <ol><li>File a <b>police complaint (FIR)</b> right away</li>
    <li>Apply for <b>re-issue</b> with the FIR copy and the declaration annexure</li>
    <li>If you’re abroad and must travel urgently, ask the embassy or consulate about an <b>Emergency Certificate</b></li></ol>
    <p>${link(PORTAL, 'Re-issue after loss')}</p>` },
  damaged: { title: 'Damaged passport', body: `
    <p>Minor and major damage are treated differently. Apply for <b>re-issue</b>, and bring the damaged passport and a declaration.</p>
    <p>${link(PORTAL, 'Re-issue for damage')}</p>` },
  overseas: { title: 'Overseas / NRI services', body: `
    <p>Apply through your <b>Indian Embassy or Consulate</b> for renewal, surrender, or an Emergency Certificate. Find the mission that serves your area.</p>
    <p>${link('https://www.mea.gov.in', 'Ministry of External Affairs')}</p>` },
  complaints: { title: 'Complaints & support', body: `
    <p>Submit and track grievances (application delay, delivery problem) through the official grievance channel. National helpline: <b>1800-258-1800</b>.</p>
    <p>${link(PORTAL, 'Grievance & support')}</p>` },
  faqs: { title: 'Passport FAQs', body: `
    <ul><li><b>Processing time:</b> varies; Tatkaal is faster.</li>
    <li><b>Validity:</b> usually 10 years for adults, 5 for minors.</li>
    <li><b>Photo:</b> use the Passport photo tool for a compliant shot.</li>
    <li><b>Travelling on an expiring passport:</b> many countries require 6 months’ validity.</li></ul>
    <p>${link(PORTAL, 'Official FAQs')}</p>` },
  links: { title: 'Official links', body: `
    <ul><li>${link(PORTAL, 'Passport Seva portal')}</li>
    <li>${link(PORTAL + '/Online/index', 'Apply · appointment · track')}</li>
    <li>${link('https://www.mea.gov.in', 'Ministry of External Affairs')}</li>
    <li>Helpline: <b>1800-258-1800</b></li></ul>` },
});

export const DISCLAIMER = 'Guidance only. Always confirm on the official portal. SnappTo can’t approve, speed up or submit applications.';
