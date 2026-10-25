import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedAdminMethods } from './serve-production-private-admin.mjs';
test('photo association uses only two concrete private routes',()=>{
  const base='/v1/admin/organizations/org/technicians/draft/profile';
  assert.deepEqual(allowedAdminMethods(base+'/binding-targets'),['GET']);
  assert.deepEqual(allowedAdminMethods(base+'/bind-application'),['POST']);
  for(const suffix of ['/binding-targets/extra','/bind-application/extra','/bind-application%2fextra','/photo-drafts'])assert.equal(allowedAdminMethods(base+suffix),undefined);
});
