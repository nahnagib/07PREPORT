"""Optional email delivery through the SMTP_* settings (the same ones the dashboard uses)."""
from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage
from pathlib import Path

from settings import Settings

log = logging.getLogger("ar_weekly.mail")


def send_outlook(to: list[str], cc: list[str], subject: str, html_body: str, attachments: list[Path]) -> None:
    """Send through the Outlook desktop app (classic Outlook, Windows) with the account already signed in there.
    No password and no SMTP needed. Outlook must be installed; it is started in the background if it is closed."""
    try:
        import win32com.client  # pywin32
    except ImportError:
        raise RuntimeError("pywin32 is not installed: run setup.cmd (or pip install pywin32)") from None
    try:
        outlook = win32com.client.Dispatch("Outlook.Application")
    except Exception as exc:
        raise RuntimeError(f"Could not start classic Outlook ({exc}). Open 'Outlook (classic)' once and sign in.") from None
    mail = outlook.CreateItem(0)  # olMailItem
    mail.To = "; ".join(to)
    if cc:
        mail.CC = "; ".join(cc)
    mail.Subject = subject
    mail.HTMLBody = html_body
    for a in attachments:
        mail.Attachments.Add(str(Path(a).resolve()))
    mail.Send()


def send(s: Settings, to: list[str], subject: str, html_body: str, attachments: list[Path], dry_run: bool = False,
         cc: list[str] | None = None) -> bool:
    to = [x for x in to if x]
    cc = list(dict.fromkeys([x for x in (cc if cc is not None else s.email_cc) if x and x not in to]))
    if not to:
        log.warning("No recipient for '%s': not sent", subject)
        return False
    if dry_run:
        log.info("[dry run] would email '%s' to %s (cc %s) with %s", subject, to, cc, [a.name for a in attachments])
        return True
    if s.email_method == "outlook":
        send_outlook(to, cc, subject, html_body, attachments)
        log.info("Emailed via Outlook '%s' to %s", subject, to)
        return True
    if not s.smtp_host:
        log.error("SMTP_HOST is not set: cannot email '%s'", subject)
        return False
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, s.smtp_from, ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg.set_content("This report is in HTML. Open the attached files if your mail app does not show it.")
    msg.add_alternative(html_body, subtype="html")
    for a in attachments:
        ctype = ("application", "vnd.openxmlformats-officedocument.spreadsheetml.sheet") if a.suffix == ".xlsx" else ("text", "html")
        msg.add_attachment(a.read_bytes(), maintype=ctype[0], subtype=ctype[1], filename=a.name)
    ctx = ssl.create_default_context()
    if s.smtp_secure:
        server = smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, context=ctx, timeout=60)
    else:
        server = smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=60)
        server.starttls(context=ctx)
    with server:
        if s.smtp_user:
            server.login(s.smtp_user, s.smtp_password)
        server.send_message(msg, to_addrs=to + cc)
    log.info("Emailed '%s' to %s", subject, to)
    return True
