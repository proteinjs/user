import React from 'react';
import { Page, Form, Fields, textField, FormButtons, FormPage } from '@proteinjs/ui';
import { routes } from '@proteinjs/user';

export const forgotPasswordPath = 'login/forgot-password';
export const forgotPasswordPage: Page = {
  name: 'Forgot Password',
  path: forgotPasswordPath,
  auth: {
    public: true,
  },
  component: () => (
    <FormPage>
      <Form<ForgotPasswordFields, typeof buttons>
        name='Forgot Password'
        createFields={() => new ForgotPasswordFields()}
        fieldLayout={['email']}
        buttons={buttons}
      />
    </FormPage>
  ),
};

class ForgotPasswordFields extends Fields {
  static create() {
    return new ForgotPasswordFields();
  }

  email = textField<ForgotPasswordFields>({
    name: 'email',
  });
}

const buttons: FormButtons<ForgotPasswordFields> = {
  submit: {
    name: 'Submit',
    style: {
      color: 'primary',
      variant: 'contained',
    },
    onClick: async (fields: ForgotPasswordFields, buttons: FormButtons<ForgotPasswordFields>) => {
      const response = await fetch(routes.initiatePasswordReset.path, {
        method: routes.initiatePasswordReset.method,
        body: JSON.stringify({
          email: fields.email.field.value,
        }),
        redirect: 'follow',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      if (response.status != 200) {
        throw new Error(`Failed to initiate forgot password, error: ${response.body}`);
      }

      const body = await response.json();
      if (body.error) {
        throw new Error(body.error);
      }

      return `Successfully sent an email with a link to reset your password.`;
    },
  },
};
