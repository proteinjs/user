import React from 'react';
import { Page, Form, Fields, textField, FormButtons, clearButton, FormPage } from '@proteinjs/ui';
import { routes } from '@proteinjs/user'

export const signupPage: Page = {
    name: 'Sign Up',
    path: 'signup',
    auth: {
        public: true,
    },
    component: () => (
        <FormPage>
            <Form<SignupFields, typeof buttons>
                name='Sign Up'
                createFields={() => new SignupFields()}
                fieldLayout={['name', 'email', 'password', 'confirmPassword']}
                buttons={buttons}
            />
        </FormPage>
    )
}

class SignupFields extends Fields {
    static create() {
        return new SignupFields();
    }

    name = textField<SignupFields>({
        name: 'name'
    });

    email = textField<SignupFields>({
        name: 'email'
    });

    password = textField<SignupFields>({
        name: 'password',
        isPassword: true
    });

    confirmPassword = textField<SignupFields>({
        name: 'confirmPassword',
        isPassword: true
    });
}

const buttons: FormButtons<SignupFields> = {
	clear: clearButton,
	signup: {
		name: 'Sign up',
		style: {
			color: 'primary',
			variant: 'contained',
		},
		onClick: async (fields: SignupFields, buttons: FormButtons<SignupFields>) => {
			const response = await fetch(routes.createUser.path, {
                method: routes.createUser.method,
                body: JSON.stringify({
                    name: fields.name.field.value,
                    email: fields.email.field.value,
                    password: fields.password.field.value
                }),
                redirect: 'follow',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            if (response.status != 200)
                throw new Error(`Failed to signup, error: ${response.statusText}`);

            const body = await response.json();
            if (body.error)
                throw new Error(body.error);

            return `Successfully created your account! Please check your email for an email confirmation.`;
		}
	}
};