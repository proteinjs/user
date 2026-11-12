import React, { useState } from 'react';
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
 * in its message seat. "Use a different account" goes back to the password form at any time.
 */
const LoginComponent: React.FC = () => {
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors<LoginField>>({});
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<PasskeyStep | undefined>();
  /** The line a passkey step that ended sent the person back with; it takes the message seat. */
  const [returnedWith, setReturnedWith] = useState<string | undefined>();
  const message = returnedWith ?? arrivalMessage(useLocation().state);

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

    setError(undefined);
    setBusy(true);
    try {
      const answer = await answerStep(step.secondStep);
      if (answer === 'cancelled' || answer === 'unavailable') {
        // Nothing was sent: the same step stands, and the same button presents it again.
        setError(answer === 'unavailable' ? WORDS.unavailable : WORDS.tryAgain);
      } else if (answer.status === 'done') {
        enter();
        return;
      } else if (answer.status === 'again') {
        setStep({ ...step, secondStep: answer.secondStep });
        setError(answer.line);
      } else {
        leaveStep(answer.line);
      }
    } catch {
      // The request itself failed (no network): whether the door saw it is not known, and the
      // next tap finds out — a step the door has spent answers restart.
      setError(WORDS.tryAgain);
    }
    setBusy(false);
  };

  /** Back to the password form, with the line the step ended on — none when the person chose to leave. */
  const leaveStep = (line?: string) => {
    setStep(undefined);
    setError(undefined);
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

/**
 * Run one passkey step: the ceremony its kind names, on the device, and — when the sheet answered
 * — the door's answer to it. Resolves to how the ceremony ended when nothing was sent.
 */
async function answerStep(
  secondStep: SignInSecondStep
): Promise<SignInSecondStepAnswer | Exclude<PasskeyCeremonyOutcome<unknown>['status'], 'done'>> {
  const ceremonies = new PasskeyCeremonies();
  const api = new AuthApi();
  if (secondStep.kind === 'passkey') {
    const sheet = await ceremonies.authenticate(secondStep.options);
    return sheet.status === 'done' ? await api.answerPasskey(sheet.response) : sheet.status;
  }

  const sheet = await ceremonies.register(secondStep.options);
  return sheet.status === 'done' ? await api.answerAddPasskey(sheet.response) : sheet.status;
}

export const loginPage: Page = {
  name: 'Login',
  path: uiRoutes.auth.login,
  auth: {
    public: true,
  },
  component: LoginComponent,
};
