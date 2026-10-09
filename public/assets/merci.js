// Retour de Stripe après un don : on s'en souvient sur ce téléphone pour ne plus solliciter.
import { translatePage, local } from './common.js';

translatePage();
local.set('wcy:donor', true);
