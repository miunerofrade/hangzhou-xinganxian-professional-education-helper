// Cascade order is part of the UI contract: base, components, themes, final layout.
import tokens from "./tokens.css";
import styles from "./styles.css";
import shellStyles from "./panel-shell.css";
import formsStyles from "./forms.css";
import settingsBaseStyles from "./settings-base.css";
import courseListStyles from "./course-list.css";
import hoursStyles from "./hours.css";
import statusStyles from "./status.css";
import buttonLayoutStyles from "./button-layout.css";
import helpStyles from "./help.css";
import switchStyles from "./switch.css";
import appearanceStyles from "./appearance.css";
import cardStyles from "./surface-card.css";
import selectStyles from "./select.css";
import actionStyles from "./action-buttons.css";
import headerStyles from "./header.css";
import buttonStates from "./button-states.css";
import elevationStyles from "./elevation.css";
import pureStyles from "./pure-neumorphism.css";
import typographyStyles from "./typography.css";
import settingsLayout from "./settings-layout.css";
import disclosureStyles from "./disclosure.css";
import logStyles from "./log.css";

export const panelStyles = [
  tokens,
  styles,
  shellStyles,
  formsStyles,
  settingsBaseStyles,
  courseListStyles,
  hoursStyles,
  statusStyles,
  buttonLayoutStyles,
  helpStyles,
  switchStyles,
  appearanceStyles,
  cardStyles,
  selectStyles,
  actionStyles,
  headerStyles,
  buttonStates,
  elevationStyles,
  pureStyles,
  typographyStyles,
  settingsLayout,
  disclosureStyles,
  logStyles,
].join("\n");
