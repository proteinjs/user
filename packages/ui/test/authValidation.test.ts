import { AuthValidation } from '../src/auth/AuthValidation';

const validSignup = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: 'hunter22',
  confirmPassword: 'hunter22',
};

describe('AuthValidation.signup', () => {
  it('accepts a complete, matching signup', () => {
    expect(AuthValidation.signup(validSignup, false)).toBeUndefined();
  });

  it('requires a name', () => {
    expect(AuthValidation.signup({ ...validSignup, name: '  ' }, false)).toBe('Please enter your name.');
  });

  it('requires a valid email when not invited', () => {
    expect(AuthValidation.signup({ ...validSignup, email: 'not-an-email' }, false)).toBe(
      'Please enter a valid email address.'
    );
  });

  it('skips the email check for invited users (the invite token carries the email)', () => {
    expect(AuthValidation.signup({ ...validSignup, email: '' }, true)).toBeUndefined();
  });

  it('requires a password', () => {
    expect(AuthValidation.signup({ ...validSignup, password: '', confirmPassword: '' }, false)).toBe(
      'Please enter a password.'
    );
  });

  it('rejects a mismatched password confirmation', () => {
    expect(AuthValidation.signup({ ...validSignup, confirmPassword: 'different' }, false)).toBe(
      'Passwords do not match.'
    );
  });
});

describe('AuthValidation.passwordReset', () => {
  it('accepts matching passwords', () => {
    expect(AuthValidation.passwordReset({ newPassword: 'hunter22', confirmPassword: 'hunter22' })).toBeUndefined();
  });

  it('requires a new password', () => {
    expect(AuthValidation.passwordReset({ newPassword: '', confirmPassword: '' })).toBe('Please enter a new password.');
  });

  it('rejects a mismatched confirmation', () => {
    expect(AuthValidation.passwordReset({ newPassword: 'hunter22', confirmPassword: 'hunter23' })).toBe(
      'Passwords do not match.'
    );
  });
});
