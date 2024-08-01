import React from 'react';
import { Page, Form, Fields, textField, FormButtons, clearButton, FormPage } from '@proteinjs/ui';
import { routes } from '@proteinjs/user';

export const invitePage: Page = {
  name: 'Send an Invite',
  path: 'invite',
  auth: {
    roles: ['admin'],
  },
  component: () => (
    <FormPage>
      <Form<InviteFields, typeof buttons>
        name='Send an Invite'
        createFields={() => new InviteFields()}
        fieldLayout={['email']}
        buttons={buttons}
      />
    </FormPage>
  ),
};

class InviteFields extends Fields {
  static create() {
    return new InviteFields();
  }

  email = textField<InviteFields>({
    name: 'email',
  });
}

const buttons: FormButtons<InviteFields> = {
  clear: clearButton,
  signup: {
    name: 'Sign up',
    style: {
      color: 'primary',
      variant: 'contained',
    },
    onClick: async (fields: InviteFields, buttons: FormButtons<InviteFields>) => {
      const response = await fetch(routes.createUser.path, {
        method: routes.createUser.method,
        body: JSON.stringify({
          name: fields.name.field.value,
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
        throw new Error(`Failed to send invite, error: ${response.statusText}`);
      }

      const body = await response.json();
      if (body.error) {
        throw new Error(body.error);
      }

      return `Successfully created your account! Please check your email for an email confirmation.`;
    },
  },
};
