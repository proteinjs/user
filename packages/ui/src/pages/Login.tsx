import React from 'react';
import { Page, Form, Fields, textField, FormButtons, clearButton, FormPage } from '@proteinjs/ui';
import { routes } from '@proteinjs/user';

export const loginPath = 'login';
export const loginPage: Page = {
  name: 'Login',
  path: loginPath,
  auth: {
    public: true,
  },
  component: () => (
    <FormPage>
      <Form<LoginFields, typeof buttons>
        name='Login'
        createFields={() => new LoginFields()}
        fieldLayout={['email', 'password']}
        buttons={buttons}
        maxWidth={'xs'}
      />
    </FormPage>
  ),
};

class LoginFields extends Fields {
  static create() {
    return new LoginFields();
  }

  email = textField<LoginFields>({
    name: 'email',
  });

  password = textField<LoginFields>({
    name: 'password',
    isPassword: true,
  });
}

const buttons: FormButtons<LoginFields> = {
  forgotPassword: {
    name: 'Forgot password',
    style: {
      variant: 'text',
      align: 'left',
    },
    redirect: async () => {
      return { path: '/login/forgot-password' };
    },
  },
  clear: clearButton,
  login: {
    name: 'Login',
    style: {
      color: 'primary',
      variant: 'contained',
    },
    onClick: async (fields: LoginFields, buttons: FormButtons<LoginFields>) => {
      const response = await fetch(routes.login.path, {
        method: routes.login.method,
        body: JSON.stringify({
          email: fields.email.field.value,
          password: fields.password.field.value,
        }),
        redirect: 'follow',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      if (response.status != 200) {
        throw new Error(`Failed to login, error: ${response.statusText}`);
      }

      const body = await response.json();
      if (body.error) {
        throw new Error(body.error);
      }

      window.location.href = '/';
    },
  },
};
