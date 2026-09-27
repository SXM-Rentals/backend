// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Draws every email the backend sends, so they all look
// like SXM Rentals rather than like a machine: the logo, a dark background, a
// large heading, one clear button, and a footer.
//
// EVERY EMAIL IS SENT TWICE OVER, in the same message: a plain-text version and
// a designed one. Mail programs that cannot or will not show the designed
// version fall back to the plain text, which is written to read properly on its
// own rather than as a leftover. Both are built from the same content here, so
// they cannot drift apart.
//
// WHY THE HTML LOOKS SO OLD-FASHIONED — tables, inline styles, no stylesheet:
// mail programs are not browsers. Outlook draws with Word, Gmail throws away
// <style> blocks and anything it does not know. Tables and inline styles are
// what actually survive. Resist tidying this into modern CSS; it will look
// broken in the places people actually read email.
//
// THE LOGO IS A LINK TO AN IMAGE, and most mail programs refuse to load images
// until the reader asks. So the logo is never the only thing carrying meaning:
// the words say everything on their own, and the image carries alt text that
// reads as the brand name when it does not load.

export type EmailContent = {
  // Shown in the inbox list beside the subject, before anything is opened.
  preheader: string;
  title: string;
  // One paragraph per entry.
  paragraphs: string[];
  // The single thing we want the reader to do.
  button?: { label: string; url: string };
  // Shown under the button, smaller — deadlines, "if this was not you", etc.
  note?: string;
};

export type EmailBrand = {
  // Where the website lives, used for the footer link and the logo.
  siteUrl: string;
  // Full address of the logo image. It must be reachable WITHOUT signing in,
  // or mail programs will show the alt text instead.
  logoUrl: string;
};

// The palette, matching the apps' dark theme.
const COLOURS = {
  background: '#0b0e11',
  card: '#12161a',
  border: '#1e242b',
  heading: '#f3f5f7',
  body: '#a2aab5',
  faint: '#78818d',
  brand: '#3daeff',
  buttonText: '#04121d',
};

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

// Anything that comes from a person or a database is escaped before it is put
// into the HTML, so a name with an "&" or a "<" in it cannot break the email or
// smuggle markup into it.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- THE PLAIN-TEXT VERSION ----
// Written to stand on its own: the button becomes the address on its own line,
// because a link nobody can click is just words.
export function renderText(content: EmailContent, brand: EmailBrand): string {
  const lines = [...content.paragraphs];
  if (content.button) lines.push('', `${content.button.label}:`, content.button.url);
  if (content.note) lines.push('', content.note);
  lines.push(
    '',
    '—',
    'SXM Rentals — car rental across Sint Maarten and Saint-Martin',
    brand.siteUrl,
    'SXM Rentals will never ask for your password by email.',
  );
  return lines.join('\n');
}

// ---- THE DESIGNED VERSION ----
export function renderHtml(content: EmailContent, brand: EmailBrand): string {
  const paragraphs = content.paragraphs
    .map(
      (text) =>
        `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:${COLOURS.body};">${escapeHtml(
          text,
        )}</p>`,
    )
    .join('');

  // A button drawn as a table cell, because that is what survives in Outlook.
  const button = content.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px auto 0;">
         <tr>
           <td align="center" bgcolor="${COLOURS.brand}" style="border-radius:10px;">
             <a href="${escapeHtml(content.button.url)}"
                style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;font-weight:600;color:${COLOURS.buttonText};text-decoration:none;border-radius:10px;">
               ${escapeHtml(content.button.label)}
             </a>
           </td>
         </tr>
       </table>
       <p style="margin:16px 0 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${COLOURS.faint};">
         If the button does not work, copy this into your browser:<br />
         <a href="${escapeHtml(content.button.url)}" style="color:${COLOURS.brand};word-break:break-all;">${escapeHtml(
           content.button.url,
         )}</a>
       </p>`
    : '';

  const note = content.note
    ? `<p style="margin:24px 0 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${COLOURS.faint};">${escapeHtml(
        content.note,
      )}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <meta name="supported-color-schemes" content="dark light" />
    <title>${escapeHtml(content.title)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:${COLOURS.background};">
    <!-- The line shown in the inbox beside the subject, then hidden. -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(content.preheader)}</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background-color:${COLOURS.background};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                 style="max-width:560px;background-color:${COLOURS.card};border:1px solid ${COLOURS.border};border-radius:16px;">

            <!-- ---- THE LOGO ---- -->
            <tr>
              <td align="center" style="padding:40px 32px 8px;">
                <a href="${escapeHtml(brand.siteUrl)}" style="text-decoration:none;">
                  <img src="${escapeHtml(brand.logoUrl)}" alt="SXM Rentals" width="150"
                       style="display:block;width:150px;max-width:60%;height:auto;border:0;" />
                </a>
              </td>
            </tr>

            <!-- ---- THE HEADING AND THE WORDS ---- -->
            <tr>
              <td align="center" style="padding:24px 32px 0;">
                <h1 style="margin:0 0 20px;font-family:${FONT};font-size:26px;line-height:1.3;font-weight:700;color:${COLOURS.heading};">
                  ${escapeHtml(content.title)}
                </h1>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 32px;text-align:center;">
                ${paragraphs}
                ${button}
                ${note}
              </td>
            </tr>

            <!-- ---- THE FOOTER ---- -->
            <tr>
              <td style="padding:32px;">
                <div style="border-top:1px solid ${COLOURS.border};padding-top:20px;">
                  <p style="margin:0 0 8px;font-family:${FONT};font-size:13px;line-height:1.6;color:${COLOURS.faint};">
                    <strong style="color:${COLOURS.body};">SXM Rentals</strong><br />
                    Car rental across Sint Maarten and Saint-Martin
                  </p>
                  <p style="margin:0 0 8px;font-family:${FONT};font-size:13px;line-height:1.6;">
                    <a href="${escapeHtml(brand.siteUrl)}" style="color:${COLOURS.brand};text-decoration:none;">
                      ${escapeHtml(brand.siteUrl.replace(/^https?:\/\//, ''))}
                    </a>
                  </p>
                  <p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${COLOURS.faint};">
                    SXM Rentals will never ask for your password by email.<br />
                    © 2026 SXM Rentals
                  </p>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// What every sender is handed: one message, both versions.
export function buildEmail(
  to: string,
  subject: string,
  content: EmailContent,
  brand: EmailBrand,
): { to: string; subject: string; text: string; html: string } {
  return {
    to,
    subject,
    text: renderText(content, brand),
    html: renderHtml(content, brand),
  };
}
