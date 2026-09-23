import { AuthFieldErrors } from './AuthValidation';

/**
 * Reads an auth form's fields from the form itself when it submits.
 *
 * A password manager, the platform's autofill service or an input method can write a field's
 * value without the `input` event React listens for: the field looks filled while component
 * state is still empty, and a controlled field's next re-render (the focus ring moving as the
 * person taps the button is enough) writes that empty state back over the value. So the fields
 * a person fills are uncontrolled — each carries a `name` and owns its value in the DOM — and
 * the submit handler reads them here. There is no second copy of a value to fall out of step.
 */
export class AuthFormFields {
  /** The named fields' current values; '' for a name the form does not carry. */
  static read<F extends string>(form: HTMLFormElement, names: readonly F[]): Record<F, string> {
    const data = new FormData(form);
    const values = {} as Record<F, string>;
    for (const name of names) {
      const value = data.get(name);
      values[name] = typeof value === 'string' ? value : '';
    }
    return values;
  }

  /** Focuses the first field, in document order, that carries an error (the keyboard opens there). */
  static focusFirstInvalid<F extends string>(form: HTMLFormElement, errors: AuthFieldErrors<F>) {
    for (let index = 0; index < form.elements.length; index++) {
      const element = form.elements[index] as HTMLInputElement;
      if (element.name && errors[element.name as F]) {
        element.focus();
        return;
      }
    }
  }
}
