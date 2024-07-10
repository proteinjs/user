import nodemailer from 'nodemailer';
import { Logger } from '@proteinjs/util';
import { Loadable, SourceRepository } from '@proteinjs/reflection';
import Mail from 'nodemailer/lib/mailer';

export interface EmailConfig {
  host: string;
  port: number;
  /** Defines if the connection should use SSL (if true) or not (if false) */
  secure: boolean;
  /** Authentication details for the email account used to send emails */
  auth: {
    user: string;
    pass: string;
  };
  from: string;
  /** Base app URL used when constructing urls within emails */
  baseUrl: string;
}

export interface DefaultEmailConfigFactory extends Loadable {
  getEmailConfig(): EmailConfig;
}

export class EmailSender {
  private static defaultEmailConfig: EmailConfig;
  private config: EmailConfig;
  private transporter: nodemailer.Transporter;
  private fromAddress: string;
  private logger: Logger;
  public baseUrl: string;

  constructor(config?: EmailConfig) {
    this.config = config ? config : this.getDefaultEmailConfig();
    this.transporter = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: this.config.auth,
    });
    this.fromAddress = this.config.from;
    this.logger = new Logger('EmailSender');
    this.baseUrl = this.config.baseUrl;
  }

  private getDefaultEmailConfig(): EmailConfig {
    if (!EmailSender.defaultEmailConfig) {
      const defaultEmailConfigFactory = SourceRepository.get().object<DefaultEmailConfigFactory>(
        '@proteinjs/user-server/DefaultEmailConfigFactory'
      );
      if (!defaultEmailConfigFactory) {
        throw new Error(
          `Unable to find a @proteinjs/user-server/DefaultEmailConfigFactory implementation. Either implement DefaultEmailConfigFactory or pass in an email config when instantiating EmailSender.`
        );
      }

      EmailSender.defaultEmailConfig = defaultEmailConfigFactory.getEmailConfig();
    }

    return EmailSender.defaultEmailConfig;
  }

  async sendEmail(mailOptions: Mail.Options): Promise<void> {
    const finalMailOptions = {
      from: this.fromAddress,
      ...mailOptions,
    };

    try {
      await this.transporter.sendMail(mailOptions);
      this.logger.info(`Email sent successfully to ${mailOptions.to}`);
    } catch (error: any) {
      this.logger.error('Error sending email:', error);
      throw new Error('Failed to send email');
    }
  }
}

export function createEmailSender(config: EmailConfig): EmailSender {
  return new EmailSender(config);
}
