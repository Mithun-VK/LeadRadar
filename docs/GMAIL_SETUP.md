# Gmail setup

How to connect the mailbox LeadRadar sends campaigns from.

---

## Before you start: what you are granting

LeadRadar requests two Gmail scopes: `gmail.send` and `gmail.readonly`.

| It can                                | It cannot                     |
| ------------------------------------- | ----------------------------- |
| Send email as you                     | Delete anything               |
| Read your mailbox, to detect replies  | Modify or move your messages  |
| —                                     | See your contacts             |

> **This changed.** LeadRadar originally requested `gmail.send` alone and stated
> that it could not read your mailbox. Reply detection — stopping follow-ups
> automatically when someone answers — cannot be built without reading, so the
> scope was widened deliberately. If you connected an account before this change,
> **sending still works** and reply detection is skipped until you reconnect; the
> Email page tells you when that is the case.

**Why the read scope is broad, and what limits it instead.** Google does not offer
a "read only the threads you sent" scope. `gmail.readonly` is the narrowest scope
that permits reading a reply's body, and the body is what makes intent
classification possible — a price request and a meeting request are
indistinguishable from headers alone. The limits are therefore enforced in
LeadRadar's own code rather than by Google:

1. **Only matched messages are stored.** A message is written to the database only
   if it matches a thread LeadRadar started — by `In-Reply-To`, by thread id, or by
   a sender address it actually emailed. Everything else is read during the scan,
   matched against nothing, and discarded.
2. **Stored reply text expires after 90 days.** The fact that someone replied is
   kept, because it drives the pipeline. Their words are not.
3. **No fuzzy matching.** There is no name or domain guessing, because a
   misattributed reply moves the wrong lead through the pipeline and stops the
   wrong campaign.

See [DATA_RETENTION.md](DATA_RETENTION.md) and
[REVENUE_ENGINE_AUDIT.md](REVENUE_ENGINE_AUDIT.md) §6.

You can revoke this access at any time at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions),
independently of this application. Revoking it stops sending immediately;
LeadRadar detects the revoked grant, marks the account invalidated, and stops
retrying rather than hammering a credential that will never work again.

**Username/password SMTP is deliberately not supported.** It requires giving this
application a password to your mailbox, it cannot be revoked without changing that
password, and Google has disabled it for most accounts anyway.

---

## 1. Create a Google Cloud project

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or select an existing one).
3. Go to **APIs & Services → Library**, search for **Gmail API**, and click
   **Enable**.

## 2. Configure the consent screen

1. **APIs & Services → OAuth consent screen**.
2. Choose **External** unless everyone using this deployment is in your Google
   Workspace organization, in which case choose **Internal**.
3. Fill in the app name, support email, and developer contact.
4. On the **Scopes** step, add:
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/userinfo.email`
5. While the app is in **Testing**, add every Google account that will connect a
   mailbox under **Test users**. An account not listed there cannot complete the
   flow.

> **Refresh tokens expire after 7 days while the app is in Testing.** That is a
> Google policy, not a LeadRadar limitation. For anything beyond trying it out,
> publish the app — or expect to reconnect weekly.

## 3. Create the OAuth client

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Under **Authorized redirect URIs**, add the callback URL, exactly:

   ```
   http://localhost:3000/api/email/gmail/callback
   ```

   For a deployed instance, use your real origin:

   ```
   https://your-domain.example/api/email/gmail/callback
   ```

   This must match `GOOGLE_REDIRECT_URI` character for character, including the
   scheme and any trailing path. A mismatch produces a `redirect_uri_mismatch`
   error at Google, before LeadRadar is ever involved.

4. Copy the client ID and client secret.

## 4. Configure LeadRadar

In `.env`:

```bash
GOOGLE_CLIENT_ID=<your client id>
GOOGLE_CLIENT_SECRET=<your client secret>
GOOGLE_REDIRECT_URI=http://localhost:3000/api/email/gmail/callback

EMAIL_SENDING_ENABLED=true
APP_PUBLIC_URL=http://localhost:3000

# 32 bytes, hex. Encrypts the stored refresh token.
ENCRYPTION_KEY=<64 hex characters>
```

Generate the encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Boot fails fast if `EMAIL_SENDING_ENABLED=true` without the OAuth client, rather
than failing halfway through the consent flow — after you have already granted
access at Google, which is a confusing place to discover a configuration error.

## 5. Connect the mailbox

1. Restart the app so the new configuration is read.
2. Open **Dashboard → Email**.
3. Click **Connect Gmail** and complete the Google consent screen.
4. Leave the **send email on your behalf** permission ticked. If you untick it,
   LeadRadar detects the missing scope and tells you immediately rather than
   letting a campaign fail silently later.
5. Click **Send a test to yourself** to prove the whole path works — token
   refresh, MIME composition, and the Gmail API call.

The test can only send to the connected mailbox's own address. There is no
recipient field, and the API has no recipient parameter: an
arbitrary-recipient test endpoint would be an open relay with a friendly name.

---

## Trying it without any of this

Set `MOCK_EXTERNAL_APIS=true` and the entire outreach pipeline runs with no
credentials at all: campaigns, enrolment, suppression, personalization, queueing,
rate limiting, retries, status tracking, and analytics. Messages are composed in
full and handed to an in-process sender that delivers nowhere.

This is a first-class runtime mode, not a test shim, and it is the right way to
evaluate the feature. Mock mode is rejected in production, so it can never be what
a real operator is unknowingly running.

---

## Where the tokens live

|                     |                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Refresh token       | AES-256-GCM encrypted with `ENCRYPTION_KEY`, in `gmail_accounts.refreshTokenCipher`                                                        |
| Access token        | Also encrypted; short-lived, refreshed ahead of expiry                                                                                     |
| Reaches the browser | **Never.** The account API returns a summary type with no token fields, so there is no path by which one can be serialised into a response |

A database leak therefore does not hand an attacker the ability to send as you —
which matters more than the leak itself, because sending as you is an act in the
world that cannot be undone.

---

## Troubleshooting

| Symptom                                      | Cause                                                                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redirect_uri_mismatch`                      | `GOOGLE_REDIRECT_URI` differs from the value registered in Google Cloud. They must match exactly.                                                                                 |
| "Google did not grant offline access"        | Google returned no refresh token. Remove the app at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and connect again, which forces a fresh consent. |
| Banner: "granted without permission to send" | The send scope was unticked on the consent screen. Connect again and leave it ticked.                                                                                             |
| Account shows "Needs reconnection"           | Google rejected the stored refresh token — access was revoked, the password changed, or the 7-day Testing-mode expiry elapsed. Reconnect.                                         |
| Sends stop partway through a campaign        | A daily limit was reached. The campaign resumes automatically after midnight UTC. Check **Dashboard → Email** for the mailbox's counter.                                          |
| `403` with a rate-limit reason               | Gmail's per-account quota. Lower the campaign's daily limit and increase the delay between messages.                                                                              |
| Nothing sends at all                         | `EMAIL_SENDING_ENABLED` is false, or no mailbox is connected. Both are shown on **Dashboard → Email**.                                                                            |

---

## Sending responsibly

The safeguards below are enforced in code, not left to the operator:

- **Suppression is checked before every send**, and again at send time rather than
  only at enrolment — someone who unsubscribes on Tuesday must not receive
  Wednesday's queued message. There is no bypass parameter anywhere in the API.
- **One message per lead per campaign**, enforced by a unique database constraint
  rather than by application care.
- **Every message carries an unsubscribe link** in the body and the standard
  `List-Unsubscribe` headers, so mail clients show a one-click opt-out. Their
  absence on bulk mail is itself a spam signal.
- **Unsubscribes and bounces are permanent** and cannot be cleared from the
  suppression list. An operator must not be able to undo a recipient's decision,
  and re-mailing a bounced address damages your own sending reputation.
- **Campaigns require explicit activation**, with a typed confirmation. Discovery
  never enrols and never sends.

What the code cannot do for you: decide whether contacting a given business is
lawful and appropriate in your jurisdiction. Business email addresses can be
personal data — under India's DPDP Act, for instance, where the business is a sole
proprietor. See [docs/legal-review-brief.md](legal-review-brief.md).
