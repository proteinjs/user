import React, { useRef, useState } from 'react';
import { Box, Link, Typography } from '@mui/material';
import { Page } from '@proteinjs/ui';
import { PasskeyCeremonies, PasskeyCeremonyOutcome, uiRoutes } from '@proteinjs/user';
import { Helmet } from 'react-helmet';
import { useLocation } from 'react-router-dom';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthTextField } from '../auth/AuthTextField';
import { AuthButton } from '../auth/AuthButton';
import { AuthFormError } from '../auth/AuthFormError';
import { AuthApi, SignInSecondStep, SignInSecondStepAnswer } from '../auth/AuthApi';
import { AuthFormFields } from '../auth/AuthFormFields';
import { AuthFieldErrors, AuthValidation } from '../auth/AuthValidation';

type LoginField = 'email' | 'password';

/**
 * What a navigation to the login page may carry in the router's location state: one plain sentence
 * for the person arriving (e.g. why they were just signed out), rendered in the page's message seat
 * above the fields. The state key is this page's API; anything that is not a non-empty string is no
 * message.
 */
export type LoginLocationState = { message?: string };

function arrivalMessage(state: unknown): string | undefined {
  const message = (state as LoginLocationState | null | undefined)?.message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

/**
 * The passkey step the page is on, after a correct password for an account that must use one: the
 * step the door answered, the address just typed, and whether this browser can run a passkey at
 * all (asked once, when the step opens — where it cannot, no button stands).
 */
type PasskeyStep = { secondStep: SignInSecondStep; address: string; available: boolean };

/**
 * The page's own words for the passkey step. A refusal's line is the door's and is shown as it
 * arrives; these are the lines for what never reaches the door — a sheet the person closed, a
 * browser that cannot run one — and the step's titles and acts.
 */
const WORDS = {
  confirmTitle: 'Confirm it’s you',
  usePasskey: 'Use passkey',
  addTitle: 'Add a passkey',
  addPasskey: 'Add passkey',
  otherAccount: 'Use a different account',
  tryAgain: 'That didn’t work. Try again.',
  unavailable: 'Passkeys aren’t available here. Log in from another browser or device.',
};

/**
 * The login page. A person types an address and a password; for most accounts that is all of it.
 * For an account that must use a passkey the door answers a second step instead of a session, and
 * the page changes in place: the title, the address just typed and ONE button, whose tap raises
 * the device's own passkey sheet — the sheet only ever comes from that tap. An account with no
 * passkey yet is asked to add its first the same way — a title and its one button, with no line
 * that explains passkeys standing on the page.
 *
 * A sheet the person closes makes no request, and the same button presents the same step again. A
 * refusal arrives from the door with a new step and its line. When the step is over (five
 * minutes, a third refusal, a failure) the page returns to the password form with the door's line
 * in its message seat. A request that never reached the door (no network) is a line above the same
 * button, and the next tap tries again.
 *
 * "Use a different account" goes back to the password form at any time — also while a tap is still
 * out, its sheet up or its request on the way: the form is free at once, a request still on its
 * way is cancelled, a sheet that answers afterwards is handed to nobody, and whatever the door
 * answers a request it had already taken — an open session, a new step — changes nothing on the
 * page the person went back to. The cancel stops a request the door has not answered; an answer
 * the door had already sent when the person pressed (a session opened for the account they left)
 * is not taken back by it.
 */
const LoginComponent: React.FC = () => {
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors<LoginField>>({});
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<PasskeyStep | undefined>();
  /** The line a passkey step that ended sent the person back with; it takes the message seat. */
  const [returnedWith, setReturnedWith] = useState<string | undefined>();
  // Read on a line of its own, on every render, and chosen between afterwards: a hook is never
  // called on one side of a choice.
  const arrival = arrivalMessage(useLocation().state);
  const message = returnedWith ?? arrival;
  /**
   * The tap whose outcome the page is waiting for, while one is out — held as the handle that
   * cancels its request. Leaving the step cancels and forgets it, and a tap that is no longer this
   * one changes nothing when its sheet or its request ends.
   */
  const awaited = useRef<AbortController | undefined>();

  const clearFieldError = (name: LoginField) =>
    setFieldErrors((errors) => (errors[name] ? { ...errors, [name]: undefined } : errors));

  /** Into the app. */
  const enter = () => {
    // REPLACE, not assign: a full navigation (the fresh load renders under the just-established
    // session), but it replaces the login page in history rather than pushing home on top of it.
    // Left in history, the login page sits one back-forward entry behind home, and a signed-in
    // user's back gesture from a route the app pushed after home can land on it — a page a
    // signed-in user can never be on. Replacing it makes home the base of their history.
    window.location.replace('/');
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The fields' values as they are NOW, read from the form — a password manager or autofill
    // that wrote a field without an input event is only in the DOM (AuthFormFields).
    const form = event.currentTarget;
    const { email, password } = AuthFormFields.read(form, ['email', 'password'] as const);
    const invalid = AuthValidation.login({ email, password });
    setFieldErrors(invalid ?? {});
    if (invalid) {
      AuthFormFields.focusFirstInvalid(form, invalid);
      return;
    }

    setError(undefined);
    setBusy(true);
    try {
      const secondStep = await new AuthApi().login(email.trim(), password);
      if (!secondStep) {
        enter();
        return;
      }

      const available = await new PasskeyCeremonies().supported();
      setReturnedWith(undefined);
      setStep({ secondStep, address: email.trim(), available });
      setError(available ? undefined : WORDS.unavailable);
      setBusy(false);
    } catch (error: any) {
      setError(error.message);
      setBusy(false);
    }
  };

  /** The step's one button: raise the device's sheet, and hand the door what it answers. */
  const onPasskey = async () => {
    if (!step) {
      return;
    }

    const tap = new AbortController();
    awaited.current = tap;
    const stillAwaited = () => awaited.current === tap;
    setError(undefined);
    setBusy(true);
    let outcome: StepOutcome | 'failed';
    try {
      outcome = await answerStep(step.secondStep, stillAwaited, tap.signal);
    } catch {
      // The request itself failed (no network): whether the door saw it is not known, and the
      // next tap finds out — a step the door has spent answers restart. A request the way back
      // cancelled ends here too, and the check below finds its tap no longer awaited.
      outcome = 'failed';
    }
    if (!stillAwaited()) {
      // The person left the step while this tap was out: the password form is theirs again, and
      // what the tap came to — a session the door opened, a new step, a failure — changes nothing.
      return;
    }

    awaited.current = undefined;
    if (outcome === 'cancelled' || outcome === 'unavailable' || outcome === 'failed') {
      // Nothing came of it: the same step stands, and the same button presents it again.
      setError(outcome === 'unavailable' ? WORDS.unavailable : WORDS.tryAgain);
    } else if (outcome.status === 'done') {
      enter();
      return;
    } else if (outcome.status === 'again') {
      setStep({ ...step, secondStep: outcome.secondStep });
      setError(outcome.line);
    } else {
      leaveStep(outcome.line);
    }
    setBusy(false);
  };

  /**
   * Back to the password form, with the line the step ended on — none when the person chose to
   * leave. The form is free at once: a tap still out is forgotten, and so is its busy mark; and
   * its request, if one is still on its way, is cancelled — the door is not left opening a session
   * for the account the person just walked away from.
   */
  const leaveStep = (line?: string) => {
    awaited.current?.abort();
    awaited.current = undefined;
    setStep(undefined);
    setError(undefined);
    setBusy(false);
    setReturnedWith(line);
  };

  if (step) {
    const adding = step.secondStep.kind === 'addPasskey';
    return (
      <>
        <Helmet>
          <title>Log in</title>
        </Helmet>
        <AuthLayout title={adding ? WORDS.addTitle : WORDS.confirmTitle} subtitle={adding ? undefined : step.address}>
          <Box data-signin-step={adding ? 'add' : 'confirm'}>
            <AuthFormError message={error} />
            {step.available && (
              <Box data-signin-act={adding ? 'add-passkey' : 'use-passkey'}>
                <AuthButton type='button' busy={busy} onClick={onPasskey}>
                  {adding ? WORDS.addPasskey : WORDS.usePasskey}
                </AuthButton>
              </Box>
            )}
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
            <Link
              component='button'
              type='button'
              data-signin-link='other-account'
              onClick={() => leaveStep()}
              underline='hover'
              sx={{
                fontFamily: 'inherit',
                fontSize: '0.875rem',
                lineHeight: 1.5,
                color: 'text.secondary',
                // 44px touch target without visual bulk.
                py: '13px',
                px: 2,
              }}
            >
              {WORDS.otherAccount}
            </Link>
          </Box>
        </AuthLayout>
      </>
    );
  }

  return (
    <>
      <Helmet>
        <title>Log in</title>
      </Helmet>
      <AuthLayout title='Log in'>
        {message && (
          // The message seat: one inset above the fields, on a quiet ground, announced politely.
          // The ground is the palette's selected tint, a plain color — the hover wash is nothing
          // at all where no pointer hovers, and the sentence then stood inset on no ground.
          <Typography
            role='status'
            sx={{
              mb: '22px',
              px: '14px',
              py: '12px',
              borderRadius: '12px',
              backgroundColor: 'action.selected',
              fontSize: '0.875rem',
              lineHeight: '20px',
              color: 'text.primary',
            }}
          >
            {message}
          </Typography>
        )}
        <form onSubmit={onSubmit} noValidate>
          {/* 'username' (not 'email'): this is the credential identifier password managers
              fill from the saved login; type='email' still gives the email keyboard. */}
          <AuthTextField
            label='Email'
            name='email'
            onChange={() => clearFieldError('email')}
            error={fieldErrors.email}
            type='email'
            autoComplete='username'
            disabled={busy}
          />
          <AuthTextField
            label='Password'
            name='password'
            onChange={() => clearFieldError('password')}
            error={fieldErrors.password}
            password
            autoComplete='current-password'
            disabled={busy}
          />
          <AuthFormError message={error} />
          <AuthButton busy={busy}>Log in</AuthButton>
        </form>
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
          <Link
            href={`/${uiRoutes.auth.forgotPassword}`}
            underline='hover'
            sx={{
              fontSize: '0.875rem',
              color: 'text.secondary',
              // 44px touch target without visual bulk.
              py: '13px',
              px: 2,
            }}
          >
            Forgot password?
          </Link>
        </Box>
      </AuthLayout>
    </>
  );
};

/** What one tap of the step's button came to: the door's answer, or how the ceremony ended when nothing was sent. */
type StepOutcome = SignInSecondStepAnswer | Exclude<PasskeyCeremonyOutcome<unknown>['status'], 'done'>;

/**
 * Run one passkey step: the ceremony its kind names, on the device, and — when the sheet answered
 * — the door's answer to it. Resolves to how the ceremony ended when nothing was sent. A sheet
 * that answers once its tap is no longer `wanted` (the person left the step while it was up) is
 * handed to nobody: nothing is sent, and it reads as a sheet that came to nothing. The request to
 * the door rides `cancel`, the tap's own signal: aborted, a request still out is cancelled.
 */
async function answerStep(
  secondStep: SignInSecondStep,
  wanted: () => boolean,
  cancel: AbortSignal
): Promise<StepOutcome> {
  const ceremonies = new PasskeyCeremonies();
  const api = new AuthApi();
  let handToTheDoor: () => Promise<SignInSecondStepAnswer>;
  if (secondStep.kind === 'passkey') {
    const sheet = await ceremonies.authenticate(secondStep.options);
    if (sheet.status !== 'done') {
      return sheet.status;
    }
    handToTheDoor = () => api.answerPasskey(sheet.response, cancel);
  } else {
    const sheet = await ceremonies.register(secondStep.options);
    if (sheet.status !== 'done') {
      return sheet.status;
    }
    handToTheDoor = () => api.answerAddPasskey(sheet.response, cancel);
  }

  return wanted() ? await handToTheDoor() : 'cancelled';
}

export const loginPage: Page = {
  name: 'Login',
  path: uiRoutes.auth.login,
  auth: {
    public: true,
  },
  component: LoginComponent,
};
