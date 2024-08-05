import React from 'react';
import { Page, Form, Fields, textField, FormButtons, FormPage } from '@proteinjs/ui';
import { getSignupService, uiRoutes } from '@proteinjs/user';
import { emailRegex } from '@proteinjs/util';
import { Stack } from '@mui/material';

export const invitePage: Page = {
  name: 'Send an Invite',
  path: uiRoutes.admin.invite,
  auth: {
    roles: ['admin'],
  },
  component: () => (
    <Stack direction='column' spacing={4} mt={2}>
      <FormPage gridItemProps={{ width: '400px' }}>
        <Form<InviteFields, typeof buttons>
          name='Send an Invite'
          createFields={() => new InviteFields()}
          fieldLayout={['email']}
          buttons={buttons}
        />
      </FormPage>

      <FormPage gridItemProps={{ width: '400px' }}>
        <Form<RevokeInviteFields, typeof revokeInviteButtons>
          name='Revoke an Invite'
          createFields={() => new RevokeInviteFields()}
          fieldLayout={['email']}
          buttons={revokeInviteButtons}
        />
      </FormPage>
    </Stack>
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
        return response.error || 'Failed to send invite.';
      }

      return `Successfully sent invite to ${email}!`;
    },
  },
};

class RevokeInviteFields extends Fields {
  static create() {
    return new InviteFields();
  }

  email = textField<InviteFields>({
    name: 'email',
  });
}

const revokeInviteButtons: FormButtons<RevokeInviteFields> = {
  signup: {
    name: 'Revoke',
    style: {
      color: 'primary',
      variant: 'contained',
    },
    onClick: async (fields: RevokeInviteFields, buttons: FormButtons<RevokeInviteFields>) => {
      const email = fields.email.field.value && fields.email.field.value.trim();

      if (!email) {
        return 'Please enter an email address.';
      }

      if (!emailRegex.test(email)) {
        return 'Please enter a valid email address.';
      }

      try {
        await getSignupService().revokeInvite(email);
      } catch {
        return `Revoke invite failed.`;
      }

      return `Successfully revoked invite to ${email}.`;
    },
  },
};
