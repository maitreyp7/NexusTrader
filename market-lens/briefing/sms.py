import smtplib
import time
import logging
from email.mime.text import MIMEText
from config.settings import SMS_EMAIL, SENDER_EMAIL, SENDER_PASSWORD

# SMS disabled — re-enable when VPS is ready
SMS_ENABLED = False

logger = logging.getLogger(__name__)


def send_sms_messages(messages: list[str], delay_seconds: float = 8.0) -> None:
    """
    Sends each message as a separate SMS via Verizon email gateway.
    delay_seconds: pause between messages so they arrive in order.
    - Validates credentials before attempting connection.
    - Logs failures to pipeline.log instead of only printing.
    - SMTP connection is always closed cleanly, even on error.
    """
    if not SMS_ENABLED:
        print("[SMS] Disabled — set SMS_ENABLED = True in sms.py when ready")
        logger.info("[SMS] SMS disabled — skipping send")
        return

    if not all([SMS_EMAIL, SENDER_EMAIL, SENDER_PASSWORD]):
        msg = "[SMS] Missing credentials. Set SMS_EMAIL, SENDER_EMAIL, SENDER_PASSWORD in .env"
        logger.error(msg)
        print(msg)
        return

    if not messages:
        logger.warning("[SMS] send_sms_messages called with empty message list")
        return

    server = None
    try:
        server = smtplib.SMTP("smtp.gmail.com", 587, timeout=30)
        server.starttls()
        server.login(SENDER_EMAIL, SENDER_PASSWORD)
        logger.info("[SMS] SMTP connection established")

        for i, message in enumerate(messages):
            msg = MIMEText(message)
            msg["From"] = SENDER_EMAIL
            msg["To"] = SMS_EMAIL
            msg["Subject"] = ""  # subject shows as first line on Verizon

            server.sendmail(SENDER_EMAIL, SMS_EMAIL, msg.as_string())
            print(f"[SMS] Sent message {i+1}/{len(messages)}")
            logger.info("[SMS] Sent message %d/%d", i + 1, len(messages))

            if i < len(messages) - 1:
                time.sleep(delay_seconds)

        logger.info("[SMS] All %d messages sent.", len(messages))
        print("[SMS] All messages sent.")

    except smtplib.SMTPAuthenticationError as e:
        logger.error("[SMS] Authentication failed — check SENDER_EMAIL and SENDER_PASSWORD: %s", e)
        print(f"[SMS] Authentication failed: {e}")
    except smtplib.SMTPException as e:
        logger.error("[SMS] SMTP error: %s", e)
        print(f"[SMS] SMTP error: {e}")
    except OSError as e:
        logger.error("[SMS] Network error connecting to SMTP: %s", e)
        print(f"[SMS] Network error: {e}")
    except Exception as e:
        logger.error("[SMS] Unexpected error: %s", e)
        print(f"[SMS] Failed to send: {e}")
    finally:
        if server:
            try:
                server.quit()
            except Exception:
                pass
