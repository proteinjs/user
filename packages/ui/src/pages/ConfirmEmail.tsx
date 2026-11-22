import React, { useEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { Page } from '@proteinjs/ui';
import { getSignupService, uiRoutes, UserAuth } from '@proteinjs/user';
import { Helmet } from 'react-helmet';
import { Navigate } from 'react-router-dom';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthButton } from '../auth/AuthButton';
import { AuthQuietLink } from '../auth/AuthQuietLink';
import { AuthApi } from '../auth/AuthApi';
import { LoginForm } from '../auth/LoginForm';
import { SignInPageFacts } from '../auth/SignInPageFacts';
import type { LoginLocationState } from './Login';

const RESEND = 'Resend';

/**
 * Every sentence of the email confirmation's screens, each kept here and nowhere else. An answer is the
 * one line under the button; `failed` ones are in the form's error ink.
 */
export const CONFIRM_EMAIL_WORDS = {
  title: 'Confirm your email',
  sentTo: 'We sent a link to',
  resend: RESEND,
  differentEmail: 'Use a different email',
  logOut: 'Log out',
  answers: {
    sent: { words: 'Sent.', failed: false },
    tooSoon: { words: 'Sent a moment ago. Try again in a few minutes.', failed: false },
    notSent: { words: 'That didn’t go through. Try again.', failed: true },
    linkGone: { words: `That link no longer works. Tap ${RESEND} for a new one.`, failed: true },
  },
  logInFirstTitle: 'Log in to confirm your email',
  linkGoneLogIn: 'That link no longer works. Log in to continue.',
} as const;

const WORDS = CONFIRM_EMAIL_WORDS;

type Answer = keyof typeof WORDS.answers;

/** What became of the mail's link: still asked about, or what the page shows once it is answered. */
type LinkOutcome = 'awaited' | 'logInFirst' | 'linkGone' | 'unanswered';

function tokenFromUrl(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  return new URLSearchParams(window.location.search).get('token') || '';
}

/**
 * THE EMAIL CONFIRMATION'S PAGE, at the address the mail's link carries (`uiRoutes.account.verifyEmail`),
 * open to everyone. With a token it is the link's landing; without one it is the one screen of a
 * session whose account waits for its address to be confirmed (`AuthenticatedPageContainer` sends such
 * a session here from every other address).
 *
 * EVERY ACT HERE THAT CHANGES WHO THE SESSION IS LOADS ITS DESTINATION ANEW (`window.location.replace`):
 * a confirmation loads the root, Log out loads Log in, Use a different email loads Sign up. The page's
 * fact that the session waits is written once, at load; a move inside the page would keep it, and the
 * container would send a visitor straight back here.
 */
const ConfirmEmailComponent: React.FC = () => {
  const [token] = useState(tokenFromUrl);
  return token ? <LinkLanding token={token} /> : <WithoutALink linkGone={false} />;
};

/**
 * The mail's link was opened. The route is asked once, and nothing but the bare ground paints until it
 * has answered (no screen shows and then goes):
 * - confirmed: the root is loaded anew, and nothing is said;
 * - log in first (nobody signed in, or another account): the log-in form under its own title, and the
 *   same address is loaded anew after the log-in, so the link is asked again in that session;
 * - a link that no longer works (used, lapsed, or replaced by a newer one): the page goes on as with no
 *   link, saying so. Where the page says this session waits it first asks once whether it still does:
 *   the fact can be older than a confirmation made a moment ago by the person's own other tap.
 * A call that cannot be made goes on as with no link, and says nothing.
 */
const LinkLanding: React.FC<{ token: string }> = ({ token }) => {
  const [outcome, setOutcome] = useState<LinkOutcome>('awaited');
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) {
      return;
    }
    asked.current = true;

    const follow = async (): Promise<LinkOutcome | undefined> => {
      const state = await new AuthApi().confirmEmail(token);
      if (state === 'confirmed') {
        window.location.replace('/');
        return undefined;
      }
      if (state === 'logInFirst') {
        return 'logInFirst';
      }
      // A question that cannot be answered leaves the page's fact standing.
      if (SignInPageFacts.awaitingEmailConfirmation() && (await leftIfNoLongerWaiting().catch(() => false))) {
        return undefined;
      }
      return 'linkGone';
    };
    follow()
      .catch((): LinkOutcome => 'unanswered')
      .then((followed) => followed && setOutcome(followed));
  }, [token]);

  if (outcome === 'awaited') {
    return <Box sx={{ flex: 1, alignSelf: 'stretch', backgroundColor: 'background.default' }} />;
  }
  if (outcome === 'logInFirst') {
    return (
      <>
        <Helmet>
          <title>{WORDS.logInFirstTitle}</title>
        </Helmet>
        <AuthLayout title={WORDS.logInFirstTitle}>
          {/* This same address, link and all, loaded anew under the session the log-in made. */}
          <LoginForm destination={`${window.location.pathname}${window.location.search}`} />
        </AuthLayout>
      </>
    );
  }
  return <WithoutALink linkGone={outcome === 'linkGone'} />;
};

/**
 * With no link to follow (none was carried, or the one carried no longer works): a signed-in person is
 * sent to the root, a waiting session sees the waiting screen, and anyone else is sent to Log in. None
 * of the three changes who the session is, so each is a move inside the page.
 */
const WithoutALink: React.FC<{ linkGone: boolean }> = ({ linkGone }) => {
  if (UserAuth.isLoggedIn()) {
    return <Navigate to='/' replace />;
  }

  const awaiting = SignInPageFacts.awaitingEmailConfirmation();
  if (awaiting) {
    return <WaitingScreen sentTo={awaiting.sentTo} linkGone={linkGone} />;
  }

  const state: LoginLocationState | undefined = linkGone ? { message: WORDS.linkGoneLogIn } : undefined;
  return <Navigate to={`/${uiRoutes.auth.login}`} replace state={state} />;
};

/**
 * THE WAITING SCREEN: where the link was sent, Resend with its one line of answer, and two quiet ways
 * out. Confirming signs nobody out, so a link opened somewhere else leaves this screen as it is: it
 * asks once each time it comes back to the front, and loads the app when the account no longer waits.
 * No timer.
 */
const WaitingScreen: React.FC<{ sentTo: string; linkGone: boolean }> = ({ sentTo, linkGone }) => {
  const [answer, setAnswer] = useState<Answer | undefined>(linkGone ? 'linkGone' : undefined);
  const [busy, setBusy] = useState(false);
  const leaving = useRef(false);

  useEffect(() => {
    let asking = false;
    const askOnComingBack = async () => {
      if (asking || document.visibilityState !== 'visible') {
        return;
      }
      asking = true;
      try {
        await leftIfNoLongerWaiting();
      } catch (error) {
        // Not answered: the screen stays as it is, and asks again the next time it comes back.
      }
      asking = false;
    };
    document.addEventListener('visibilitychange', askOnComingBack);
    window.addEventListener('focus', askOnComingBack);
    return () => {
      document.removeEventListener('visibilitychange', askOnComingBack);
      window.removeEventListener('focus', askOnComingBack);
    };
  }, []);

  // The answer that is there stays while the button shows its spinner, and the new one takes its
  // place in the same paint: an answer is replaced, never removed and put back.
  const resend = async () => {
    setBusy(true);
    let next: Answer;
    try {
      const response = await getSignupService().resendEmailVerification();
      if (response.sent) {
        next = 'sent';
      } else if (response.whyNot === 'alreadyConfirmed') {
        // Confirmed somewhere else since the screen last asked: the app, loaded anew.
        window.location.replace('/');
        return;
      } else {
        next = response.whyNot;
      }
    } catch (error) {
      next = 'notSent';
    }
    setAnswer(next);
    setBusy(false);
  };

  /** Ends the session, then loads `destination` anew. A session that could not be ended says so in the answer's line. */
  const endSessionAndLoad = (destination: string) => async (event: React.MouseEvent) => {
    event.preventDefault();
    if (leaving.current) {
      return;
    }
    leaving.current = true;
    try {
      await new AuthApi().logout();
    } catch (error) {
      leaving.current = false;
      setAnswer('notSent');
      return;
    }
    window.location.replace(destination);
  };

  const signup = `/${uiRoutes.auth.signup}`;
  const login = `/${uiRoutes.auth.login}`;
  return (
    <>
      <Helmet>
        <title>{WORDS.title}</title>
      </Helmet>
      <AuthLayout title={WORDS.title} subtitle={<SentToLine address={sentTo} />}>
        <Box sx={{ mt: 1 }}>
          <AuthButton type='button' busy={busy} onClick={resend}>
            {WORDS.resend}
          </AuthButton>
        </Box>
        <AnswerLine answer={answer} />
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <AuthQuietLink href={signup} onClick={endSessionAndLoad(signup)}>
            {WORDS.differentEmail}
          </AuthQuietLink>
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <AuthQuietLink href={login} onClick={endSessionAndLoad(login)}>
            {WORDS.logOut}
          </AuthQuietLink>
        </Box>
      </AuthLayout>
    </>
  );
};

/**
 * Where the link was sent: the words and the address, the address in the reading ink so a mistyped one
 * is seen at a glance. THE ADDRESS IS NEVER BROKEN AFTER ITS OWN HYPHEN (a hyphen left at a line's end
 * reads as a mark that was added): each hyphen is held to the letter after it, so an address that does
 * not fit beside the words moves to the next line whole, and only one longer than a whole line is
 * broken, at the line's edge. It stays plain text in the line, with no letter added or changed.
 */
const SentToLine: React.FC<{ address: string }> = ({ address }) => (
  <>
    {`${WORDS.sentTo} `}
    <Box component='span' sx={{ color: 'text.primary', fontWeight: 500, overflowWrap: 'anywhere' }}>
      {address.split(/(-+.?)/).map((piece, index) =>
        index % 2 ? (
          <Box component='span' key={index} sx={{ whiteSpace: 'nowrap' }}>
            {piece}
          </Box>
        ) : (
          piece
        )
      )}
    </Box>
  </>
);

/** The answer's line: the form's own size and leading, centered like the button's own word, in even lines. */
const answerLineSx = { fontSize: '0.875rem', lineHeight: 1.45, textAlign: 'center', textWrap: 'balance' } as const;

/**
 * The one line under the button: the answer to the last tap, staying until the next. ITS ROOM IS THERE
 * FROM THE FIRST PAINT, as tall as the tallest of its sentences at this width and text size, so the two
 * quiet lines under it never move when an answer comes or changes: every sentence is laid in the one
 * cell, unseen and hidden from a screen reader, and the shown one is painted in that same cell. The
 * shown line is one element that is always there; its words are replaced in place.
 */
const AnswerLine: React.FC<{ answer: Answer | undefined }> = ({ answer }) => {
  const shown = answer ? WORDS.answers[answer] : undefined;
  return (
    <Box sx={{ display: 'grid', mt: 2 }}>
      {(Object.keys(WORDS.answers) as Answer[]).map((key) => (
        <Typography key={key} aria-hidden sx={{ ...answerLineSx, gridArea: '1 / 1', visibility: 'hidden' }}>
          {WORDS.answers[key].words}
        </Typography>
      ))}
      <Typography
        role={shown?.failed ? 'alert' : 'status'}
        sx={{ ...answerLineSx, gridArea: '1 / 1', color: shown?.failed ? 'error.main' : 'text.primary' }}
      >
        {shown ? shown.words : ''}
      </Typography>
    </Box>
  );
};

/**
 * Asks whether this session's account still waits, and leaves when it does not: confirmed, the root is
 * loaded anew; nobody (the account is gone or deactivated), Log in is. Resolves true when it left.
 */
async function leftIfNoLongerWaiting(): Promise<boolean> {
  const { state } = await getSignupService().emailConfirmationState();
  if (state === 'waiting') {
    return false;
  }

  window.location.replace(state === 'confirmed' ? '/' : `/${uiRoutes.auth.login}`);
  return true;
}

export const confirmEmailPage: Page = {
  name: 'Confirm Email',
  path: uiRoutes.account.verifyEmail,
  auth: {
    public: true,
  },
  component: ConfirmEmailComponent,
};
