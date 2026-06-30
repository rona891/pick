import { test, expect } from '@playwright/test';

test.describe('Autenticación', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#login-view')).toBeVisible();
  });

  test('login exitoso muestra hub', async ({ page }) => {
    await page.fill('#email', 'ADMIN');
    await page.fill('#password', 'hello2');
    await page.click('#login-btn');
    await expect(page.locator('#hub-view')).toBeVisible();
    await expect(page.locator('#login-view')).not.toBeVisible();
  });

  test('credenciales incorrectas muestran error', async ({ page }) => {
    await page.fill('#email', 'ADMIN');
    await page.fill('#password', 'clave-incorrecta');
    await page.click('#login-btn');
    await expect(page.locator('#login-error')).toBeVisible();
    await expect(page.locator('#login-view')).toBeVisible();
  });
});
