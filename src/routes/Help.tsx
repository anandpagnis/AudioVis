import { useState } from 'react'
import { Link } from 'react-router'

/**
 * /help — reached from AccountMenu's dropdown. A request/feedback form with
 * no backend behind it yet (F248, explicit scope: ship the UI loop now, wire
 * storage later) — submitting just flips this component to a thank-you
 * state client-side. Nothing is sent, saved, or emailed. Kept honest in the
 * code/ISSUES.md even though the UI itself doesn't say so, matching what was
 * asked: a complete-feeling loop to test, not a "coming soon" placeholder
 * like Marketplace/Billing.
 */
export function Help() {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const canSubmit = title.trim().length > 0 && body.trim().length > 0

  return (
    <div className="help">
      <div className="help-nav">
        <Link className="help-mark" to="/" title="Back to Lilim">
          LILIM
        </Link>
      </div>

      <div className="help-body">
        <span className="help-eyebrow">Help</span>
        <h1 className="help-title">Request or feedback</h1>
        <p className="help-sub">Bug, idea, or just something you want to see next — tell us.</p>

        {submitted ? (
          <div className="help-thanks">
            <p className="help-thanks-title">Thank you — submitted.</p>
            <p className="help-thanks-body">We've got it.</p>
            <button
              className="help-navlink"
              onClick={() => {
                setTitle('')
                setBody('')
                setSubmitted(false)
              }}
            >
              Send another
            </button>
          </div>
        ) : (
          <form
            className="help-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (canSubmit) setSubmitted(true)
            }}
          >
            <label className="help-field">
              <span className="help-field-label">Title</span>
              <input
                className="help-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="One line — what's this about?"
                maxLength={120}
              />
            </label>
            <label className="help-field">
              <span className="help-field-label">Details</span>
              <textarea
                className="help-textarea"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="As much or as little as you want to share."
                rows={6}
              />
            </label>
            <button className="help-submit" type="submit" disabled={!canSubmit}>
              Submit
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
