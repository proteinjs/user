import { AuthValidation } from '../src/auth/AuthValidation';

const validSignup = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: 'hunter22',
  confirmPassword: 'hunter22',
};

describe('AuthValidation.login', () => {
  it('accepts an email and a password', () => {
    expect(AuthValidation.login({ email: 'ada@example.com', password: 'hunter22' })).toBeUndefined();
  });

  it('marks every blank field', () => {
    expect(AuthValidation.login({ email: '', password: '' })).toEqual({
      email: 'Enter your email',
      password: 'Enter your password',
    });
  });

  it('treats a whitespace-only email as blank, and marks only the blank field', () => {
    expect(AuthValidation.login({ email: '   ', password: 'hunter22' })).toEqual({ email: 'Enter your email' });
  });
});

describe('AuthValidation.forgotPassword', () => {
  it('accepts an email', () => {
    expect(AuthValidation.forgotPassword({ email: 'ada@example.com' })).toBeUndefined();
  });

  it('marks a blank email', () => {
    expect(AuthValidation.forgotPassword({ email: ' ' })).toEqual({ email: 'Enter your email' });
  });
});

describe('AuthValidation.signup', () => {
  it('accepts a complete, matching signup', () => {
    expect(AuthValidation.signup(validSignup, false)).toBeUndefined();
  });

  it('requires a name', () => {
    expect(AuthValidation.signup({ ...validSignup, name: '  ' }, false)).toEqual({ name: 'Enter your name' });
  });

  it('requires an email when not invited', () => {
    expect(AuthValidation.signup({ ...validSignup, email: '' }, false)).toEqual({ email: 'Enter your email' });
  });

  it('requires a valid email when not invited', () => {
    expect(AuthValidation.signup({ ...validSignup, email: 'not-an-email' }, false)).toEqual({
      email: 'Enter a valid email address',
    });
  });

  it('skips the email check for invited users (the invite token carries the email)', () => {
    expect(AuthValidation.signup({ ...validSignup, email: '' }, true)).toBeUndefined();
  });

  it('requires a password', () => {
    expect(AuthValidation.signup({ ...validSignup, password: '', confirmPassword: '' }, false)).toEqual({
      password: 'Enter a password',
    });
  });

  it('marks a mismatched password confirmation on the confirmation', () => {
    expect(AuthValidation.signup({ ...validSignup, confirmPassword: 'different' }, false)).toEqual({
      confirmPassword: 'Passwords do not match',
    });
  });
});

describe('AuthValidation.passwordReset', () => {
  it('accepts matching passwords', () => {
    expect(AuthValidation.passwordReset({ newPassword: 'hunter22', confirmPassword: 'hunter22' })).toBeUndefined();
  });

  it('requires a new password', () => {
    expect(AuthValidation.passwordReset({ newPassword: '', confirmPassword: '' })).toEqual({
      newPassword: 'Enter a new password',
    });
  });

  it('marks a mismatched confirmation on the confirmation', () => {
    expect(AuthValidation.passwordReset({ newPassword: 'hunter22', confirmPassword: 'hunter23' })).toEqual({
      confirmPassword: 'Passwords do not match',
    });
  });
});
