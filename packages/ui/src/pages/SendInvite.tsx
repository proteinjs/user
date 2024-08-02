import React from 'react';
import { Page, Form, Fields, textField, FormButtons, FormPage } from '@proteinjs/ui';
import { getSignupService, uiRoutes } from '@proteinjs/user';
import { emailRegex } from '@proteinjs/util';

export const invitePage: Page = {
  name: 'Send an Invite',
  path: uiRoutes.admin.invite,
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
  signup: {
    name: 'Send',
    style: {
      color: 'primary',
      variant: 'contained',
    },
    onClick: async (fields: InviteFields, buttons: FormButtons<InviteFields>) => {
      const email = fields.email.field.value && fields.email.field.value.trim();

      if (!email) {
        return 'Please enter an email address.';
      }

      if (!emailRegex.test(email)) {
        return 'Please enter a valid email address.';
      }

      const response = await getSignupService().sendInvite(email);
      if (response.sent === false) {
        return 'Failed to send invite.';
      }

      return `Successfully sent invite to ${email}!`;
    },
  },
};
