import {Routes} from '@angular/router';
import {DockerDashboard} from './docker-dashboard/docker-dashboard';

export const routes: Routes = [
  {
    path: '',
    component: DockerDashboard
  },
  {
    path: '**',
    redirectTo: ''
  }
];
