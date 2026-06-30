import { expect } from '@playwright/test';

export async function login(page, username = 'ADMIN', password = 'hello2') {
  await page.goto('/');
  await expect(page.locator('#login-view')).toBeVisible();
  await page.fill('#email', username);
  await page.fill('#password', password);
  await page.click('#login-btn');
  await expect(page.locator('#hub-view')).toBeVisible();
}

export async function irAAdminClientes(page) {
  await login(page);
  await page.click('.mayorista-card[data-mayorista="yaguar"]');
  await expect(page.locator('#app-view')).toBeVisible();
  await page.click('button[data-tab="admin"]');
  await expect(page.locator('#admin-panel')).toBeVisible();
}
